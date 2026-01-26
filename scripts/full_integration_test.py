import requests
import json
from datetime import datetime
import base64

# Test registration with a real email this time
test_email = 'johnduvill+test' + str(int(datetime.now().timestamp())) + '@gmail.com'

# Create minimal base64 dummy files for license and photo
dummy_file_b64 = base64.b64encode(b"dummy file content").decode('utf-8')

data = {
    'first_name': 'Test',
    'last_name': 'Registration',
    'email': test_email,
    'date_of_birth': '2000-01-15',
    'nationality': 'South African',
    'gender': 'Male',
    'championship': 'Formula 1 (F1)',
    'class': 'Class A',
    'race_number': '42',
    'team_name': 'Test Team',
    'coach_name': 'Test Coach',
    'kart_brand': 'Tony',
    'transponder_number': '123456',
    'contact_name': 'Parent Contact',
    'contact_phone': '0712345678',
    'contact_relationship': 'Parent',
    'license_b64': dummy_file_b64,
    'license_name': 'license.pdf',
    'license_mime': 'application/pdf',
    'photo_b64': dummy_file_b64,
    'photo_name': 'photo.jpg',
    'photo_mime': 'image/jpeg',
    'password': 'TestPass123!@#'
}

print(f"🚀 Full Integration Test")
print(f"📧 Email: {test_email}")
print()

# Test 1: Register user
print("1️⃣  Testing user registration...")
r = requests.post('https://rokthenats.co.za/api/registerDriver', json=data)
if r.status_code == 200:
    result = r.json()
    driver_id = result['data']['driver_id']
    print(f"   ✅ Registration successful!")
    print(f"   Driver ID: {driver_id}")
    print(f"   Status: {result['data']['status']}")
    print(f"   Message: {result['data']['message']}")
    print()
    
    # Test 2: Try to login immediately (before admin approval, so should fail with pending message)
    print("2️⃣  Testing login with new credentials...")
    login_data = {
        'email': test_email,
        'password': data['password']
    }
    r_login = requests.post('https://rokthenats.co.za/api/loginWithPassword', json=login_data)
    print(f"   Response: {r_login.status_code}")
    print(f"   Data: {json.dumps(r_login.json(), indent=6)}")
    print()
    
    # Test 3: Test password reset flow
    print("3️⃣  Testing password reset request...")
    reset_data = {'email': test_email}
    r_reset = requests.post('https://rokthenats.co.za/api/requestPasswordReset', json=reset_data)
    print(f"   Response: {r_reset.status_code}")
    print(f"   Data: {json.dumps(r_reset.json(), indent=6)}")
else:
    print(f"   ❌ Registration failed: {r.status_code}")
    print(f"   Response: {json.dumps(r.json(), indent=2)}")
