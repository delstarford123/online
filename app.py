import os
import time
from functools import wraps
from flask import Flask, jsonify, request, abort, render_template
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, db
from dotenv import load_dotenv
from agora_token_builder.RtcTokenBuilder import RtcTokenBuilder, Role_Publisher

# Load environment variables
load_dotenv()

app = Flask(__name__)
CORS(app)

# --- Configuration ---
# Hardcoded for demo purposes; in production, use a more secure method
SECRET_TOKEN = os.getenv('BACKEND_AUTH_TOKEN', 'church-demo-token-2024')
STARTING_POS = {"x": 400, "y": 550}  # The 'doorway' of the map

# Agora Configuration
AGORA_APP_ID = os.getenv('AGORA_APP_ID', 'YOUR_APP_ID_HERE')
AGORA_APP_CERTIFICATE = os.getenv('AGORA_APP_CERTIFICATE', 'YOUR_APP_CERTIFICATE_HERE')

# Initialize Firebase Admin SDK
cred = credentials.Certificate("ServiceAccountKey.json")
firebase_admin.initialize_app(cred, {
    'databaseURL': os.getenv('REACT_APP_FIREBASE_DATABASE_URL')
})

# --- Middleware / Decorators ---

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get('Authorization')
        if not token or token != f"Bearer {SECRET_TOKEN}":
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated

# --- Routes ---

@app.route('/')
def index():
    # Pass Firebase client-side config to the frontend
    firebase_config = {
        "apiKey": os.getenv('REACT_APP_FIREBASE_API_KEY'),
        "authDomain": os.getenv('REACT_APP_FIREBASE_AUTH_DOMAIN'),
        "databaseURL": os.getenv('REACT_APP_FIREBASE_DATABASE_URL'),
        "projectId": os.getenv('REACT_APP_FIREBASE_PROJECT_ID'),
        "storageBucket": os.getenv('REACT_APP_FIREBASE_STORAGE_BUCKET'),
        "messagingSenderId": os.getenv('REACT_APP_FIREBASE_MESSAGING_SENDER_ID'),
        "appId": os.getenv('REACT_APP_FIREBASE_APP_ID'),
        "measurementId": os.getenv('REACT_APP_FIREBASE_MEASUREMENT_ID')
    }
    return render_template('index.html', firebase_config=firebase_config)

@app.route('/api/rtc-token', methods=['GET'])
def get_rtc_token():
    """Generates an Agora RTC token for a given UID and channel."""
    uid = request.args.get('uid')
    channel_name = request.args.get('channel_name', 'main_sanctuary')
    
    if not uid:
        return jsonify({"error": "uid is required"}), 400

    try:
        # Build token with 2-hour expiration
        expiration_time_in_seconds = 7200
        current_timestamp = int(time.time())
        privilege_expired_ts = current_timestamp + expiration_time_in_seconds

        token = RtcTokenBuilder.buildTokenWithUid(
            AGORA_APP_ID, 
            AGORA_APP_CERTIFICATE, 
            channel_name, 
            int(uid), 
            Role_Publisher, 
            privilege_expired_ts
        )
        
        return jsonify({
            'token': token,
            'appId': AGORA_APP_ID
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

import uuid

# ... (keep existing imports)

@app.route('/api/join', methods=['POST'])
def join_service():
    """
    Public registration endpoint with optional RBAC passcode.
    Expects: { "name": "string", "passcode": "string" }
    """
    data = request.json
    if not data or 'name' not in data:
        return jsonify({"error": "Name is required"}), 400
    
    user_id = str(uuid.uuid4())
    user_name = data['name']
    passcode = data.get('passcode', '')
    
    # Simple RBAC Logic
    role = 'pastor' if passcode == 'pastor123' else 'member'
    
    # Return identity, role, and starting position
    return jsonify({
        "user_id": user_id,
        "name": user_name,
        "role": role,
        "startX": 400,
        "startY": 550,
        "message": f"Welcome, {role} {user_name}!"
    }), 200

@app.route('/api/room-status', methods=['GET'])
def get_room_status():
    """Fetch the current state of the sanctuary room."""
    try:
        ref = db.reference('rooms/main_sanctuary')
        snapshot = ref.get()
        return jsonify(snapshot), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/clear-users', methods=['POST'])
@require_auth
def clear_users():
    """Administrative route to clear all active users."""
    try:
        ref = db.reference('rooms/main_sanctuary/users')
        ref.delete()
        return jsonify({"message": "All users cleared"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
