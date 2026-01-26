#!/usr/bin/env python
import json
import requests

email = 'johnduvill@gmail.com'
url = 'https://rokthenats.co.za/api/test-email'
data = {'email': email}

print(f'📧 Sending test registration email to {email}...')

try:
    response = requests.post(url, json=data)
    print(f'✅ Success! Status: {response.status_code}')
    print(f'Response: {response.text}')
except Exception as e:
    print(f'❌ Error: {e}')
