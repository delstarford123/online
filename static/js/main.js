/**
 * Online Sanctuary - Main Canvas Logic
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, set, onValue, update, onDisconnect, push, serverTimestamp, limitToLast, query } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// --- FIREBASE CONFIGURATION ---
const configElement = document.getElementById('firebase-config');
const firebaseConfig = JSON.parse(configElement.textContent);

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// --- CANVAS SETUP ---
const canvas = document.getElementById('churchMap');
const ctx = canvas.getContext('2d');
const WIDTH = 800;
const HEIGHT = 600;

const ALTAR_HEIGHT = 150;
const AISLE_WIDTH = 80;
const FOYER_HEIGHT = 50;
const WALL_THICKNESS = 8;
const SEAT_WIDTH = 30;
const SEAT_HEIGHT = 15;
const SEAT_SPACING_X = 6;
const SEAT_SPACING_Y = 18;
const ROW_COUNT = 10;
const SEATS_PER_BLOCK = 6;

// --- STATE ---
let pews = []; 
let activeUsers = {};
let syncedPews = {};
let localUserId = null;
let localUserName = null;
let localUserRole = 'member'; // Default RBAC role
let localUserColor = `hsl(${Math.random() * 360}, 70%, 60%)`;

// Agora State
let agoraClient = null;
let localTracks = { videoTrack: null, audioTrack: null };
let agoraUid = Math.floor(Math.random() * 1000000); 

// --- DOM ELEMENTS ---
const lobbyOverlay = document.getElementById('lobby-overlay');
const canvasContainer = document.getElementById('canvas-container');
const joinBtn = document.getElementById('join-btn');
const usernameInput = document.getElementById('username-input');
const passcodeInput = document.getElementById('passcode-input');

function setupLobby() {
    joinBtn.addEventListener('click', handleJoin);
    usernameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleJoin();
    });
}

async function handleJoin() {
    const name = usernameInput.value.trim();
    const passcode = passcodeInput.value.trim();

    if (!name) {
        alert("Please enter a name to join.");
        return;
    }

    console.log(`[Lobby] Attempting to join as: ${name}`);
    joinBtn.disabled = true;
    joinBtn.innerText = "Joining...";

    try {
        const response = await fetch('/api/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, passcode: passcode })
        });

        if (!response.ok) throw new Error('Registration failed');

        const userData = await response.json();
        console.log("[Lobby] Registration successful:", userData);

        localUserId = userData.user_id;
        localUserName = userData.name;
        localUserRole = userData.role;

        // Show role-based controls
        if (localUserRole === 'pastor') {
            document.getElementById('moderation-panel').style.display = 'block';
        } else {
            document.getElementById('member-controls').style.display = 'block';
        }

        // Transitions
        lobbyOverlay.style.display = 'none';
        canvasContainer.style.display = 'block';

        initApplication(userData.startX, userData.startY);

    } catch (error) {
        console.error("[Lobby] Error joining:", error);
        alert("Could not join service. Please try again.");
        joinBtn.disabled = false;
        joinBtn.innerText = "Join Service";
    }
}

function initApplication(startX, startY) {
    console.log("[App] Initializing Sanctuary Environment...");
    
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    
    pews = generatePewLayout();
    
    // 1. Initialize Local User in Firebase
    const userRef = ref(db, `church/users/${localUserId}`);
    set(userRef, {
        id: localUserId,
        agoraUid: agoraUid,
        name: localUserName,
        role: localUserRole, // Sync role to Firebase
        color: localUserColor,
        x: startX,
        y: startY,
        targetX: startX,
        targetY: startY
    });
    onDisconnect(userRef).remove();

    // 2. Start Agora
    initializeAgora(agoraUid);

    // 3. Sync Listeners
    onValue(ref(db, 'church/users'), (snapshot) => {
        activeUsers = snapshot.val() || {};
        updateUI();
        if (localUserRole === 'pastor') updateModerationPanel();
    });

    // --- MODERATION: Individual User Listener ---
    onValue(ref(db, `church/users/${localUserId}`), (snapshot) => {
        const userData = snapshot.val();
        if (userData?.canSpeak && localUserRole === 'member') {
            if (localTracks.audioTrack) {
                localTracks.audioTrack.setMuted(false);
                showToast("You are now live!");
                // Clear canSpeak so they don't get stuck live if they rejoin
                update(ref(db, `church/users/${localUserId}`), { canSpeak: false });
            }
        }
    });

    onValue(ref(db, 'church/pews'), (snapshot) => {
        syncedPews = snapshot.val() || {};
    });

    const chatQuery = query(ref(db, 'church/chat'), limitToLast(20));
    onValue(chatQuery, (snapshot) => {
        displayMessages(snapshot.val());
    });

    // 3. Interactions
    canvas.addEventListener('mousedown', handleCanvasClick);
    document.getElementById('chat-send').addEventListener('click', sendMessage);
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    // --- MODERATION & SPATIAL UI EVENTS ---
    document.getElementById('raise-hand-btn').addEventListener('click', toggleRaiseHand);

    requestAnimationFrame(gameLoop);
    
    // --- SPATIAL AUDIO LOOP (500ms) ---
    setInterval(updateSpatialAudio, 500);

    console.log("[App] Loop Started.");
}

// --- MODERATION HELPERS ---

async function toggleRaiseHand() {
    const userRef = ref(db, `church/users/${localUserId}`);
    const isRaised = activeUsers[localUserId]?.handRaised || false;
    
    await update(userRef, { handRaised: !isRaised });
    
    const btn = document.getElementById('raise-hand-btn');
    if (!isRaised) {
        btn.classList.add('raised');
        btn.innerText = "Hand Raised ✋";
    } else {
        btn.classList.remove('raised');
        btn.innerText = "Raise Hand ✋";
    }
}

function updateModerationPanel() {
    const list = document.getElementById('raised-hands-list');
    list.innerHTML = '';
    
    Object.keys(activeUsers).forEach(id => {
        const user = activeUsers[id];
        if (user.handRaised) {
            const li = document.createElement('li');
            li.className = 'hand-item';
            li.innerHTML = `
                <span>${user.name}</span>
                <button class="allow-btn" onclick="allowToSpeak('${id}')">Allow</button>
            `;
            list.appendChild(li);
        }
    });
}

window.allowToSpeak = async (userId) => {
    const userRef = ref(db, `church/users/${userId}`);
    await update(userRef, {
        canSpeak: true,
        handRaised: false
    });
    console.log(`[Moderation] Allowed ${userId} to speak.`);
};

function showToast(message) {
    const toast = document.getElementById('notification-toast');
    toast.innerText = message;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

// --- SPATIAL AUDIO LOGIC ---

function calculateDistance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

function getVolumeFromDistance(distance) {
    const minDistance = 50;
    const maxDistance = 300;
    
    if (distance <= minDistance) return 100;
    if (distance >= maxDistance) return 0;
    
    // Linear scale: 100 to 0
    return 100 * (1 - (distance - minDistance) / (maxDistance - minDistance));
}

function updateSpatialAudio() {
    if (!agoraClient || !activeUsers[localUserId]) return;

    const localUser = activeUsers[localUserId];
    
    // Get all remote users in the Agora channel
    const remoteUsers = agoraClient.remoteUsers;
    
    remoteUsers.forEach(agoraUser => {
        // Find the matching Firebase user by agoraUid
        const firebaseUser = Object.values(activeUsers).find(u => u.agoraUid == agoraUser.uid);
        
        if (firebaseUser && agoraUser.audioTrack) {
            let volume = 100;

            // Pastor Override: Pastor is always at 100% volume
            if (firebaseUser.role !== 'pastor') {
                const distance = calculateDistance(localUser.x, localUser.y, firebaseUser.x, firebaseUser.y);
                volume = getVolumeFromDistance(distance);
            }

            agoraUser.audioTrack.setVolume(Math.floor(volume));
        }
    });
}

function handleCanvasClick(event) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // --- RBAC SPATIAL BOUNDARY ---
    if (localUserRole === 'member' && mouseY < ALTAR_HEIGHT) {
        console.warn("Only Pastors can enter the stage.");
        return; // Block movement
    }

    let seatClicked = false;
    pews.forEach(seat => {
        if (mouseX >= seat.x && mouseX <= seat.x + SEAT_WIDTH &&
            mouseY >= seat.y && mouseY <= seat.y + SEAT_HEIGHT) {
            
            seatClicked = true;
            const pewRef = ref(db, `church/pews/${seat.id}`);
            const currentOccupant = syncedPews[seat.id]?.occupiedBy;

            if (!currentOccupant) {
                update(pewRef, { occupiedBy: localUserId, userName: localUserName });
                update(ref(db, `church/users/${localUserId}`), {
                    targetX: seat.x + SEAT_WIDTH / 2,
                    targetY: seat.y + SEAT_HEIGHT / 2
                });
            } else if (currentOccupant === localUserId) {
                set(pewRef, null);
                update(ref(db, `church/users/${localUserId}`), {
                    targetX: mouseX,
                    targetY: mouseY
                });
            }
        }
    });

    // If no seat clicked, just move there
    if (!seatClicked) {
        update(ref(db, `church/users/${localUserId}`), {
            targetX: mouseX,
            targetY: mouseY
        });
    }
}

function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (text) {
        push(ref(db, 'church/chat'), {
            name: localUserName,
            text: text,
            timestamp: serverTimestamp()
        });
        input.value = '';
    }
}

function displayMessages(messages) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    if (!messages) return;

    Object.values(messages).forEach(msg => {
        const div = document.createElement('div');
        div.className = 'chat-msg';
        div.innerHTML = `<b>${msg.name}:</b> ${msg.text}`;
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

function gameLoop() {
    drawChurchMap(ctx, pews);
    
    Object.keys(activeUsers).forEach(id => {
        const user = activeUsers[id];
        if (user.x !== user.targetX || user.y !== user.targetY) {
            user.x += (user.targetX - user.x) * 0.1;
            user.y += (user.targetY - user.y) * 0.1;
        }
        drawAvatar(user);

        // Update Agora Video Bubble Position
        if (user.agoraUid) {
            const videoBubble = document.getElementById(`player-${user.agoraUid}`);
            if (videoBubble) {
                videoBubble.style.left = `${user.x - 25}px`;
                videoBubble.style.top = `${user.y - 70}px`;
            }
        }
    });

    requestAnimationFrame(gameLoop);
}

function drawAvatar(user) {
    const radius = 12;

    // --- RBAC VISUAL DIFFERENTIATION ---
    if (user.role === 'pastor') {
        ctx.strokeStyle = '#ffd700'; // Gold Halo
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(user.x, user.y, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.fillStyle = user.color;
    ctx.beginPath();
    ctx.arc(user.x, user.y, radius, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = '#2d3436';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    const label = user.role === 'pastor' ? `[Pastor] ${user.name}` : user.name;
    ctx.fillText(label, user.x, user.y - radius - 10);
    
    // --- MODERATION: Hand Emoji ---
    if (user.handRaised) {
        ctx.font = '16px serif';
        ctx.fillText('✋', user.x + radius + 5, user.y - radius);
    }

    if (user.id === localUserId) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(user.x, user.y, radius, 0, Math.PI * 2);
        ctx.stroke();
    }
}

function drawChurchMap(ctx, pewsArray) {
    ctx.fillStyle = '#f3e5ab';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#dfe6e9';
    ctx.fillRect((WIDTH / 2) - (AISLE_WIDTH / 2), ALTAR_HEIGHT, AISLE_WIDTH, HEIGHT - ALTAR_HEIGHT - FOYER_HEIGHT);
    ctx.fillStyle = '#b2bec3';
    ctx.fillRect(0, 0, WIDTH, ALTAR_HEIGHT);
    ctx.fillStyle = '#2d3436';
    ctx.fillRect(WIDTH / 2 - 2, 20, 4, 60);
    ctx.fillRect(WIDTH / 2 - 20, 35, 40, 4);
    pewsArray.forEach(seat => {
        ctx.fillStyle = syncedPews[seat.id] ? '#e74c3c' : '#ffffff';
        ctx.strokeStyle = '#b2bec3';
        ctx.beginPath();
        ctx.roundRect(seat.x, seat.y, SEAT_WIDTH, SEAT_HEIGHT, 4);
        ctx.fill();
        ctx.stroke();
    });
    ctx.strokeStyle = '#2d3436';
    ctx.lineWidth = WALL_THICKNESS;
    ctx.strokeRect(WALL_THICKNESS/2, WALL_THICKNESS/2, WIDTH - WALL_THICKNESS, HEIGHT - WALL_THICKNESS);
}

function generatePewLayout() {
    const seats = [];
    const leftBlockStartX = (WIDTH / 2) - (AISLE_WIDTH / 2) - (SEATS_PER_BLOCK * (SEAT_WIDTH + SEAT_SPACING_X));
    const rightBlockStartX = (WIDTH / 2) + (AISLE_WIDTH / 2);
    for (let row = 0; row < ROW_COUNT; row++) {
        const y = ALTAR_HEIGHT + 40 + (row * (SEAT_HEIGHT + SEAT_SPACING_Y));
        for (let s = 0; s < SEATS_PER_BLOCK; s++) {
            seats.push({ id: `L-R${row}-S${s}`, x: leftBlockStartX + (s * (SEAT_WIDTH + SEAT_SPACING_X)), y: y });
            seats.push({ id: `R-R${row}-S${s}`, x: rightBlockStartX + (s * (SEAT_WIDTH + SEAT_SPACING_X)), y: y });
        }
    }
    return seats;
}

function updateUI() {
    const userInfo = document.getElementById('user-info');
    if (userInfo) {
        userInfo.innerText = `${localUserName} | Users Online: ${Object.keys(activeUsers).length}`;
    }
}

async function initializeAgora(uid) {
    console.log(`[Agora] Initializing for UID: ${uid}`);
    const channelName = 'main_sanctuary';
    
    try {
        const response = await fetch(`/api/rtc-token?uid=${uid}&channel_name=${channelName}`);
        const data = await response.json();
        const token = data.token;
        const appId = data.appId;

        agoraClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

        agoraClient.on("user-published", async (user, mediaType) => {
            await agoraClient.subscribe(user, mediaType);
            if (mediaType === "video") {
                const remoteVideoTrack = user.videoTrack;
                const playerContainer = document.createElement("div");
                playerContainer.id = `player-${user.uid}`;
                playerContainer.className = "video-bubble";
                playerContainer.style.width = "50px";
                playerContainer.style.height = "50px";
                playerContainer.style.borderRadius = "50%";
                playerContainer.style.overflow = "hidden";
                playerContainer.style.position = "absolute";
                playerContainer.style.border = "2px solid white";
                playerContainer.style.backgroundColor = "black";
                playerContainer.style.zIndex = "5";
                document.getElementById("video-container").append(playerContainer);
                remoteVideoTrack.play(playerContainer);
            }
            if (mediaType === "audio") {
                user.audioTrack.play();
            }
        });

        agoraClient.on("user-unpublished", (user) => {
            const playerContainer = document.getElementById(`player-${user.uid}`);
            if (playerContainer) playerContainer.remove();
        });

        await agoraClient.join(appId, channelName, token, uid);

        localTracks.audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        localTracks.videoTrack = await AgoraRTC.createCameraVideoTrack();

        // --- MODERATION: Default Mute State ---
        if (localUserRole === 'member') {
            localTracks.audioTrack.setMuted(true);
            console.log("[Moderation] Member joined muted.");
        }

        const localPlayerContainer = document.createElement("div");
        localPlayerContainer.id = `player-${uid}`;
        localPlayerContainer.className = "video-bubble";
        localPlayerContainer.style.width = "50px";
        localPlayerContainer.style.height = "50px";
        localPlayerContainer.style.borderRadius = "50%";
        localPlayerContainer.style.overflow = "hidden";
        localPlayerContainer.style.position = "absolute";
        localPlayerContainer.style.border = "2px solid #3498db";
        localPlayerContainer.style.backgroundColor = "black";
        localPlayerContainer.style.zIndex = "5";
        document.getElementById("video-container").append(localPlayerContainer);
        localTracks.videoTrack.play(localPlayerContainer);

        await agoraClient.publish([localTracks.audioTrack, localTracks.videoTrack]);
        console.log("[Agora] Local tracks published.");

    } catch (err) {
        console.error("[Agora] Initialization failed", err);
    }
}

// Start in Lobby Mode
setupLobby();
