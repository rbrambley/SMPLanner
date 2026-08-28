#!/usr/bin/env python3
"""One-time helper to generate a YouTube API refresh token.

Usage:
1. Download client_secret.json from Google Cloud (OAuth Desktop app).
2. Run: python scripts/get_refresh_token.py client_secret.json
3. Copy the refresh_token into the GOOGLE_REFRESH_TOKEN GitHub secret.
"""

import json
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
]


def main():
    client_secrets = sys.argv[1] if len(sys.argv) > 1 else 'client_secret.json'
    flow = InstalledAppFlow.from_client_secrets_file(client_secrets, SCOPES)
    creds = flow.run_local_server(port=0)

    print('Add these values as GitHub Actions secrets:')
    print(f'  GOOGLE_CLIENT_ID={creds.client_id}')
    print(f'  GOOGLE_CLIENT_SECRET={creds.client_secret}')
    print(f'  GOOGLE_REFRESH_TOKEN={creds.refresh_token}')

    with open('credentials.json', 'w') as f:
        json.dump({
            'client_id': creds.client_id,
            'client_secret': creds.client_secret,
            'refresh_token': creds.refresh_token,
        }, f, indent=2)
    print('\nAlso written to credentials.json (do not commit this file).')


if __name__ == '__main__':
    main()
