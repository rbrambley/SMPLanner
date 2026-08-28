#!/usr/bin/env python3
"""Daily YouTube analytics fetcher for the SMPLanner dashboard.

Reads YouTube Data API v3 and YouTube Analytics API v2, then writes:
- analytics.json (time-series + latest per video)
- content.json (merges latest stats into each song)

Environment variables used:
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REFRESH_TOKEN
- YOUTUBE_CHANNEL_ID (optional; derived from the authenticated user if not set)
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
]

TOKEN_URI = 'https://oauth2.googleapis.com/token'

# Metrics supported by the YouTube Analytics API for the reports we use.
# 'shares', 'subscribersLost' and 'playlistStarts' are not available for
# per-video reports, so they are intentionally excluded here.
REPORT_METRICS = 'views,likes,comments,estimatedMinutesWatched,averageViewDuration,subscribersGained'
MINIMAL_VIDEO_METRICS = 'views,likes,estimatedMinutesWatched,averageViewDuration'

DAYS_BACK = 30


def get_credentials():
    client_id = os.environ['GOOGLE_CLIENT_ID']
    client_secret = os.environ['GOOGLE_CLIENT_SECRET']
    refresh_token = os.environ['GOOGLE_REFRESH_TOKEN']

    creds = Credentials(
        None,
        refresh_token=refresh_token,
        token_uri=TOKEN_URI,
        client_id=client_id,
        client_secret=client_secret,
        scopes=SCOPES,
    )
    creds.refresh(Request())
    return creds


def build_services(creds):
    return (
        build('youtube', 'v3', credentials=creds, cache_discovery=False),
        build('youtubeAnalytics', 'v2', credentials=creds, cache_discovery=False),
    )


def get_channel_id(youtube):
    env_id = os.environ.get('YOUTUBE_CHANNEL_ID')
    if env_id:
        return env_id
    res = youtube.channels().list(part='id', mine=True).execute()
    if not res.get('items'):
        raise RuntimeError('No YouTube channel found for the authenticated user.')
    return res['items'][0]['id']


def get_uploads_playlist_id(youtube, channel_id):
    res = youtube.channels().list(part='contentDetails', id=channel_id).execute()
    return res['items'][0]['contentDetails']['relatedPlaylists']['uploads']


def get_all_video_ids(youtube, playlist_id):
    video_ids = []
    page_token = None
    while True:
        res = youtube.playlistItems().list(
            playlistId=playlist_id,
            part='contentDetails',
            maxResults=50,
            pageToken=page_token,
        ).execute()
        for item in res.get('items', []):
            video_ids.append(item['contentDetails']['videoId'])
        page_token = res.get('nextPageToken')
        if not page_token:
            break
    return video_ids


def get_video_metadata(youtube, video_ids):
    metadata = {}
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i:i + 50]
        res = youtube.videos().list(
            id=','.join(batch),
            part='snippet,statistics',
        ).execute()
        for item in res.get('items', []):
            vid = item['id']
            metadata[vid] = {
                'title': item['snippet']['title'],
                'publishedAt': item['snippet']['publishedAt'],
                'thumbnails': item['snippet'].get('thumbnails', {}),
                'statistics': item.get('statistics', {}),
            }
    return metadata


def parse_report(report):
    headers = [h['name'] for h in report.get('columnHeaders', [])]
    rows = []
    for raw in report.get('rows', []):
        row = dict(zip(headers, raw))
        for k, v in row.items():
            if k in ('views', 'likes', 'comments', 'shares', 'subscribersGained',
                     'subscribersLost', 'playlistStarts'):
                try:
                    row[k] = int(v)
                except (ValueError, TypeError):
                    pass
            elif k in ('estimatedMinutesWatched', 'averageViewDuration'):
                try:
                    row[k] = float(v)
                except (ValueError, TypeError):
                    pass
        rows.append(row)
    return rows


def run_analytics_query(youtube_analytics, channel_id, start, end, metrics, dimensions):
    try:
        res = youtube_analytics.reports().query(
            ids=f'channel=={channel_id}',
            startDate=start,
            endDate=end,
            metrics=metrics,
            dimensions=dimensions,
        ).execute()
        return parse_report(res)
    except HttpError as e:
        if e.resp.status == 400:
            print(f'Analytics query not supported for metrics={metrics}, dimensions={dimensions}: {e}',
                  file=sys.stderr)
            return None
        raise


def fetch_latest_per_video(youtube_analytics, channel_id, start, end):
    data = run_analytics_query(youtube_analytics, channel_id, start, end, REPORT_METRICS, 'video')
    if data is None:
        # Fall back to the smallest set known to work with the 'video' dimension.
        data = run_analytics_query(
            youtube_analytics, channel_id, start, end,
            MINIMAL_VIDEO_METRICS, 'video',
        )
    return data


def fetch_daily_per_video(youtube_analytics, channel_id, start, end):
    data = run_analytics_query(
        youtube_analytics, channel_id, start, end, REPORT_METRICS, 'video,day'
    )
    if data is None:
        data = run_analytics_query(
            youtube_analytics, channel_id, start, end,
            MINIMAL_VIDEO_METRICS, 'video,day'
        ) or []
    return data


def build_analytics_document(channel_id, start, end, video_ids, metadata, latest, daily, channel_daily):
    latest_by_video = {row.get('video'): row for row in latest if 'video' in row}
    daily_by_video = {}
    for row in daily:
        if 'video' not in row:
            continue
        daily_by_video.setdefault(row['video'], []).append(row)

    videos = []
    for vid in video_ids:
        meta = metadata.get(vid, {})
        videos.append({
            'videoId': vid,
            'title': meta.get('title', ''),
            'publishedAt': meta.get('publishedAt', ''),
            'videoType': infer_video_type(meta.get('title', '')),
            'latest': latest_by_video.get(vid, {}),
            'daily': daily_by_video.get(vid, []),
        })

    return {
        'lastUpdated': datetime.now(timezone.utc).isoformat(),
        'channelId': channel_id,
        'period': {'start': start, 'end': end},
        'videos': videos,
        'channelDaily': channel_daily,
    }


def infer_video_type(title):
    tl = title.lower()
    if 'short' in tl or 'yt short' in tl or '#short' in tl:
        return 'Short'
    if 'lyric' in tl or 'official lyric video' in tl:
        return 'Lyric Video'
    if 'full video' in tl or 'official video' in tl:
        return 'Full Video'
    return 'Unknown'


def load_content():
    path = Path('content.json')
    if not path.exists():
        return {'songs': [], 'schedule': [], 'tasks': []}
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def match_video_to_song(song, videos, metadata):
    short_id = (song.get('links') or {}).get('youtube_short_id', '')
    lyric_id = (song.get('links') or {}).get('youtube_lyric_id', '')
    if short_id and short_id in videos:
        return short_id
    if lyric_id and lyric_id in videos:
        return lyric_id

    title = song.get('title', '').lower()
    # Try to find a video whose title contains the song title or vice versa.
    for vid, meta in metadata.items():
        vt = meta.get('title', '').lower()
        if title and (title in vt or vt in title):
            return vid
    return None


def merge_stats_into_content(content, metadata, latest):
    latest_by_video = {row.get('video'): row for row in latest if 'video' in row}
    video_ids = set(latest_by_video.keys())

    for song in content.get('songs', []):
        matched = match_video_to_song(song, video_ids, metadata)
        if matched and matched in latest_by_video:
            stats = latest_by_video[matched]
            song['stats'] = {
                'views': stats.get('views', 0),
                'likes': stats.get('likes', 0),
                'comments': stats.get('comments', 0),
                'estimatedMinutesWatched': stats.get('estimatedMinutesWatched', 0.0),
                'averageViewDuration': stats.get('averageViewDuration', 0.0),
                'subscribersGained': stats.get('subscribersGained', 0),
                'lastUpdated': datetime.now(timezone.utc).isoformat(),
                'videoId': matched,
            }
        elif 'stats' in song:
            # Keep existing stats if no match; do not wipe.
            pass
    return content


def main():
    try:
        creds = get_credentials()
    except Exception as e:
        print(f'Authentication failed: {e}', file=sys.stderr)
        sys.exit(1)

    youtube, youtube_analytics = build_services(creds)

    channel_id = get_channel_id(youtube)
    print(f'Using channel: {channel_id}')

    uploads_playlist = get_uploads_playlist_id(youtube, channel_id)
    print(f'Uploads playlist: {uploads_playlist}')

    video_ids = get_all_video_ids(youtube, uploads_playlist)
    print(f'Found {len(video_ids)} videos.')

    metadata = get_video_metadata(youtube, video_ids)

    end = datetime.now(timezone.utc).date() - timedelta(days=1)
    start = end - timedelta(days=DAYS_BACK)
    start_str = start.isoformat()
    end_str = end.isoformat()
    print(f'Fetching analytics from {start_str} to {end_str}')

    latest = fetch_latest_per_video(youtube_analytics, channel_id, start_str, end_str)
    daily = fetch_daily_per_video(youtube_analytics, channel_id, start_str, end_str) or []
    channel_daily = run_analytics_query(
        youtube_analytics, channel_id, start_str, end_str,
        REPORT_METRICS, 'day',
    ) or []

    analytics_doc = build_analytics_document(
        channel_id, start_str, end_str, video_ids, metadata, latest, daily, channel_daily
    )
    save_json('analytics.json', analytics_doc)
    print('Saved analytics.json')

    content = load_content()
    content = merge_stats_into_content(content, metadata, latest)
    save_json('content.json', content)
    print('Saved content.json')


if __name__ == '__main__':
    main()
