import psycopg2
import os
from datetime import datetime

# Get database URL from environment
db_url = os.environ.get('DATABASE_URL')
if not db_url:
    print('❌ DATABASE_URL environment variable not set')
    exit(1)

try:
    # Connect to database
    conn = psycopg2.connect(db_url)
    cursor = conn.cursor()
    
    # Check medical_consent table
    cursor.execute('SELECT * FROM medical_consent')
    results = cursor.fetchall()
    
    print('\n=== MEDICAL CONSENT DATA ===')
    print(f'Total records: {len(results)}\n')
    
    if len(results) == 0:
        print('❌ No medical data found in database')
    else:
        # Get column names
        col_names = [desc[0] for desc in cursor.description]
        
        for i, row in enumerate(results, 1):
            print(f'Record {i}:')
            for col, val in zip(col_names, row):
                print(f'  {col}: {val or "(none)"}')
            print()
    
    # Check total driver count
    cursor.execute('SELECT COUNT(*) FROM drivers')
    driver_count = cursor.fetchone()[0]
    print(f'Total drivers in system: {driver_count}')
    
    cursor.close()
    conn.close()
    
except Exception as e:
    print(f'❌ Database error: {str(e)}')
    exit(1)
