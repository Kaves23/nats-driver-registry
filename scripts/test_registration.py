import requests
import json
from datetime import datetime
import base64

# Test registration
test_email = f'testuser{int(datetime.now().timestamp())}@example.com'

# Create minimal base64 dummy files for license and photo
dummy_file_b64 = base64.b64encode(b"dummy file content").decode('utf-8')

data = {
    'first_name': 'Test',
    'last_name': 'User',
    'email': test_email,
    'date_of_birth': '2000-01-15',
    'nationality': 'South African',
    'gender': 'Male',
    'championship': 'Karting (Trophies)',
    'class': 'Class A',
    'race_number': '001',
    'team_name': 'Test Team',
    'coach_name': 'Test Coach',
    'kart_brand': 'Tony',
    'transponder_number': '123456',
    'contact_name': 'Contact Name',
    'contact_phone': '0712345678',
    'contact_relationship': 'Parent',
    'license_b64': dummy_file_b64,
    'license_name': 'license.pdf',
    'license_mime': 'application/pdf',
    'photo_b64': dummy_file_b64,
    'photo_name': 'photo.jpg',
    'photo_mime': 'image/jpeg',
    'password': 'TestPassword123!'
}

print(f"📋 Testing registration with email: {test_email}")
r = requests.post('https://rokthenats.co.za/api/registerDriver', json=data)
print(f'✅ Registration Status: {r.status_code}')
print(f'Response: {json.dumps(r.json(), indent=2)}')
