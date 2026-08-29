#!/usr/bin/env python3
"""Daily YouTube analytics fetcher for the SMPLanner dashboard.

Reads YouTube Data API v3 and YouTube Analytics API v2, then writes
analytics.json with time-series and latest metrics per video.

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

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
]

TOKEN_URI = 'https://oauth2.googleapis.com/token'

# YouTube Analytics is strict about which metrics can be combined with which
# dimensions. Views/likes/comments come from the Data API (statistics), which
# is more reliable for those public counts. We use Analytics for watch time and
# subscriber metrics, where it is the only source.
VIDEO_ANALYTICS_METRICS = 'views,estimatedMinutesWatched,subscribersGained'
VIDEO_ANALYTICS_FALLBACK = 'views,estimatedMinutesWatched'
VIDEO_DAILY_METRICS = 'views,estimatedMinutesWatched'
CHANNEL_DAILY_METRICS = 'views,likes,comments,estimatedMinutesWatched,subscribersGained'

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
            if k in ('views', 'likes', 'comments', 'subscribersGained'):
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
            print(f'Analytics query not supported for metrics={metrics}, dimensions={dimensions}.',
                  file=sys.stderr)
            return None
        raise


def fetch_video_analytics(youtube_analytics, channel_id, start, end):
    data = run_analytics_query(
        youtube_analytics, channel_id, start, end, VIDEO_ANALYTICS_METRICS, 'video'
    )
    if data is None:
        data = run_analytics_query(
            youtube_analytics, channel_id, start, end, VIDEO_ANALYTICS_FALLBACK, 'video'
        )
    return data or []


def fetch_daily_per_video(youtube_analytics, channel_id, start, end):
    data = run_analytics_query(
        youtube_analytics, channel_id, start, end, VIDEO_DAILY_METRICS, 'video,day'
    )
    return data or []


def build_video_stats(video_id, metadata, analytics_row):
    meta = metadata.get(video_id, {})
    stats = meta.get('statistics', {})
    analytics = analytics_row or {}

    views = int(analytics.get('views', 0) or 0)
    public_views = int(stats.get('viewCount', 0) or 0)
    likes = int(stats.get('likeCount', 0) or 0)
    comments = int(stats.get('commentCount', 0) or 0)
    estimated = float(analytics.get('estimatedMinutesWatched', 0.0) or 0.0)
    subscribers = int(analytics.get('subscribersGained', 0) or 0)

    if views and estimated:
        avg = (estimated * 60) / views
    else:
        avg = 0.0

    return {
        'views': views,
        'publicViews': public_views,
        'likes': likes,
        'comments': comments,
        'estimatedMinutesWatched': round(estimated, 2),
        'averageViewDuration': round(avg, 2),
        'subscribersGained': subscribers,
    }


def build_analytics_document(channel_id, start, end, video_ids, metadata, latest, daily, channel_daily):
    latest_by_video = {row.get('video'): row for row in latest if 'video' in row}
    daily_by_video = {}
    for row in daily:
        if 'video' not in row:
            continue
        daily_by_video.setdefault(row['video'], []).append({
            'date': row.get('day', ''),
            'views': row.get('views', 0),
            'estimatedMinutesWatched': row.get('estimatedMinutesWatched', 0.0),
        })

    videos = []
    for vid in video_ids:
        meta = metadata.get(vid, {})
        analytics_row = latest_by_video.get(vid, {})
        latest_stats = build_video_stats(vid, metadata, analytics_row)
        videos.append({
            'videoId': vid,
            'title': meta.get('title', ''),
            'publishedAt': meta.get('publishedAt', ''),
            'videoType': infer_video_type(meta.get('title', '')),
            'latest': latest_stats,
            'daily': daily_by_video.get(vid, []),
        })

    return {
        'lastUpdated': datetime.now(timezone.utc).isoformat(),
        'channelId': channel_id,
        'period': {'start': start, 'end': end},
        'metricBasis': 'period-views-and-watchtime-public-engagement',
        'videos': videos,
        'channelDaily': channel_daily,
    }


def infer_video_type(title):
    tl = (title or '').lower()
    if 'short' in tl or 'yt short' in tl or '#short' in tl:
        return 'Short'
    if 'lyric' in tl or 'official lyric video' in tl:
        return 'Lyric Video'
    if 'full video' in tl or 'official video' in tl:
        return 'Full Video'
    return 'Unknown'


def save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


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

    latest = fetch_video_analytics(youtube_analytics, channel_id, start_str, end_str)
    daily = fetch_daily_per_video(youtube_analytics, channel_id, start_str, end_str)
    channel_daily = run_analytics_query(
        youtube_analytics, channel_id, start_str, end_str,
        CHANNEL_DAILY_METRICS, 'day',
    ) or []

    analytics_doc = build_analytics_document(
        channel_id, start_str, end_str, video_ids, metadata, latest, daily, channel_daily
    )
    save_json('analytics.json', analytics_doc)
    print('Saved analytics.json')



if __name__ == '__main__':
    main()
