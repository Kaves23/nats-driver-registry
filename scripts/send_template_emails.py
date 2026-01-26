#!/usr/bin/env python3
"""
Mailchimp Email Sender - Simplified
Sends test emails using built-in Python libraries
"""

import json
import urllib.request
import urllib.error
from pathlib import Path
import os

def load_template(template_name, variables=None):
    """Load email template and replace variables"""
    if variables is None:
        variables = {}
    
    template_path = Path(__file__).parent / 'email-templates' / f'{template_name}.html'
    
    if not template_path.exists():
        raise FileNotFoundError(f"Template not found: {template_path}")
    
    with open(template_path, 'r', encoding='utf-8') as f:
        html = f.read()
    
    # Replace variables
    for key, value in variables.items():
        html = html.replace(f'{{{{{key}}}}}', value)
    
    return html

def read_env():
    """Read .env file and return values"""
    env_file = Path(__file__).parent / '.env'
    env_vars = {}
    
    if env_file.exists():
        with open(env_file, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    env_vars[key.strip()] = value.strip()
    
    return env_vars

def send_email(to_email, template_name, subject, variables=None):
    """Send email via Mailchimp Transactional API"""
    if variables is None:
        variables = {}
    
    # Load environment
    env = read_env()
    api_key = env.get('MAILCHIMP_API_KEY', '')
    from_email = env.get('MAILCHIMP_FROM_EMAIL', '')
    
    if not api_key:
        print("❌ Error: MAILCHIMP_API_KEY not found in .env")
        return False
    
    if not from_email:
        print("❌ Error: MAILCHIMP_FROM_EMAIL not found in .env")
        return False
    
    # Load template
    try:
        html_content = load_template(template_name, variables)
    except FileNotFoundError as e:
        print(f"❌ Error: {e}")
        return False
    
    # Prepare request
    payload = {
        'key': api_key,
        'message': {
            'to': [{'email': to_email}],
            'from_email': from_email,
            'subject': subject,
            'html': html_content
        }
    }
    
    print(f"\n📧 Sending email:")
    print(f"   To: {to_email}")
    print(f"   From: {from_email}")
    print(f"   Subject: {subject}")
    print(f"   Template: {template_name}.html")
    print(f"   Content size: {len(html_content)} bytes")
    
    # Send request
    try:
        url = 'https://mandrillapp.com/api/1.0/messages/send.json'
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            url,
            data=data,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.loads(response.read().decode('utf-8'))
        
        if isinstance(result, list) and len(result) > 0:
            msg = result[0]
            if 'error' in msg and msg['error']:
                print(f"❌ Mailchimp Error: {msg.get('error', 'Unknown error')}")
                return False
            print(f"✅ Email sent successfully!")
            print(f"   Message ID: {msg.get('_id', 'N/A')}")
            print(f"   Status: {msg.get('status', 'queued')}")
            return True
        else:
            print(f"⚠️  Unexpected response: {result}")
            return False
            
    except urllib.error.HTTPError as e:
        error_msg = e.read().decode('utf-8')
        try:
            error_json = json.loads(error_msg)
            print(f"❌ HTTP {e.code}: {error_json.get('message', 'Unknown error')}")
        except:
            print(f"❌ HTTP {e.code}: {error_msg[:200]}")
        return False
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def main():
    """Main function"""
    recipient = 'john@rokcup.co.za'
    
    print("=" * 70)
    print(" NATS Email Template Sender")
    print("=" * 70)
    
    # Send Registration Confirmation
    print("\n" + "=" * 70)
    print(" TEST 1: REGISTRATION CONFIRMATION")
    print("=" * 70)
    success1 = send_email(
        to_email=recipient,
        template_name='registration-confirmation',
        subject='Welcome to the 2026 ROK Cup South Africa NATS',
        variables={}
    )
    
    # Send Password Reset
    print("\n" + "=" * 70)
    print(" TEST 2: PASSWORD RESET")
    print("=" * 70)
    reset_link = f'https://rokthenats.co.za/reset-password.html?token=test_token_12345&email={recipient}'
    success2 = send_email(
        to_email=recipient,
        template_name='password-reset',
        subject='Reset Your NATS Driver Registry Password',
        variables={
            'RESET_LINK': reset_link
        }
    )
    
    # Summary
    print("\n" + "=" * 70)
    print(" SUMMARY")
    print("=" * 70)
    print(f"Registration Confirmation: {'✅ Sent' if success1 else '❌ Failed'}")
    print(f"Password Reset:            {'✅ Sent' if success2 else '❌ Failed'}")
    
    if success1 and success2:
        print(f"\n✅ All emails sent successfully to {recipient}\n")
        return 0
    else:
        print(f"\n⚠️  Some emails failed to send\n")
        return 1

if __name__ == '__main__':
    import sys
    try:
        sys.exit(main())
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        sys.exit(1)
