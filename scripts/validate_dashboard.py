import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def fail(message):
    raise AssertionError(message)


def main():
    content = json.loads((ROOT / 'content.json').read_text(encoding='utf-8'))
    dashboard = (ROOT / 'dashboard.js').read_text(encoding='utf-8')
    index = (ROOT / 'index.html').read_text(encoding='utf-8')

    if content.get('schema_version') != 1:
        fail('content.json must declare schema_version 1')

    song_ids = [song['id'] for song in content.get('songs', [])]
    release_ids = [release['id'] for release in content.get('releases', [])]
    if len(song_ids) != len(set(song_ids)):
        fail(f'duplicate song ids: {[key for key, count in Counter(song_ids).items() if count > 1]}')
    if len(release_ids) != len(set(release_ids)):
        fail(f'duplicate release ids: {[key for key, count in Counter(release_ids).items() if count > 1]}')

    songs = set(song_ids)
    releases = set(release_ids)
    for entry in content.get('schedule', []):
        if entry.get('song_id') not in songs:
            fail(f'orphan schedule song: {entry.get("song_id")}')
    for song in content.get('songs', []):
        if song.get('release_id') and song['release_id'] not in releases:
            fail(f'orphan song release: {song["id"]} -> {song["release_id"]}')
    for release in content.get('releases', []):
        for song_id in release.get('songs', []):
            if song_id not in songs:
                fail(f'orphan release song: {release["id"]} -> {song_id}')

    html_ids = set(re.findall(r'id="([^"]+)"', index))
    generated_ids = set(re.findall(r'id=[\\"\']([^\\"\']+)[\\"\']', dashboard))
    referenced_ids = set(re.findall(r"getElementById\('([^']+)'\)", dashboard))
    missing = sorted(referenced_ids - html_ids - generated_ids)
    if missing:
        fail(f'dashboard.js references missing HTML ids: {missing}')

    forbidden = ['data-index=', 'generateReleasePlanPrompt']
    found = [value for value in forbidden if value in dashboard]
    if found:
        fail(f'legacy index-based or stale code remains: {found}')

    print(f'Validated {len(song_ids)} songs, {len(content.get("schedule", []))} posts, and {len(release_ids)} releases.')


if __name__ == '__main__':
    main()
