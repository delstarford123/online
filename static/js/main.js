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
let localRoomId = null;
let localUserRole = 'member'; 
let localUserColor = `hsl(${Math.random() * 360}, 70%, 60%)`;

// Agora State
let agoraClient = null;
let screenClient = null;
let localTracks = { videoTrack: null, audioTrack: null, screenTrack: null };
let agoraUid = Math.floor(Math.random() * 1000000); 

let activeReactions = []; // Local list of reactions to animate

// --- GLOBAL HELPERS FOR INDEX.HTML ---
window.sendReaction = (emoji) => {
    if (!localUserId || !localRoomId) return;
    const reactionRef = ref(db, `services/${localRoomId}/reactions`);
    push(reactionRef, {
        userId: localUserId,
        emoji: emoji,
        timestamp: serverTimestamp()
    });
};

async function toggleScreenShare() {
    const btn = document.getElementById('screen-share-btn');
    
    if (!localTracks.screenTrack) {
        try {
            console.log("[Agora] Starting screen share...");
            localTracks.screenTrack = await AgoraRTC.createScreenVideoTrack();
            
            localTracks.screenTrack.on("track-ended", () => {
                stopScreenShare();
            });

            if (!screenClient) {
                screenClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
            }
            
            const screenUid = agoraUid + 1000;
            const response = await fetch(`/api/rtc-token?uid=${screenUid}&channel_name=${localRoomId}`);
            const { token, appId } = await response.json();
            
            await screenClient.join(appId, localRoomId, token, screenUid);
            await screenClient.publish(localTracks.screenTrack);
            
            await update(ref(db, `services/${localRoomId}`), { 
                screenShareActive: true, 
                screenShareUid: screenUid 
            });

            btn.classList.add('active');
            btn.innerText = "Stop Sharing 🛑";
            showToast("Screen sharing started!");

        } catch (err) {
            console.error("[Agora] Screen share failed", err);
            showToast("Screen share cancelled.");
        }
    } else {
        stopScreenShare();
    }
}

async function stopScreenShare() {
    const btn = document.getElementById('screen-share-btn');
    if (localTracks.screenTrack) {
        localTracks.screenTrack.close();
        localTracks.screenTrack = null;
    }
    if (screenClient) {
        await screenClient.leave();
    }
    await update(ref(db, `services/${localRoomId}`), { screenShareActive: false });
    btn.classList.remove('active');
    btn.innerText = "Share Screen 🖥️";
}

// --- DOM ELEMENTS ---
const lobbyOverlay = document.getElementById('lobby-overlay');
const canvasContainer = document.getElementById('canvas-container');
const joinBtn = document.getElementById('join-btn');
const usernameInput = document.getElementById('username-input');
const roomIdInput = document.getElementById('room-id-input');
const passcodeInput = document.getElementById('passcode-input');

function setupLobby() {
    joinBtn.addEventListener('click', handleJoin);
    [usernameInput, roomIdInput, passcodeInput].forEach(input => {
        if (input) {
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleJoin();
            });
        }
    });
}

async function handleJoin() {
    const name = usernameInput.value.trim();
    const roomId = roomIdInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const passcode = passcodeInput.value.trim();

    if (!name || !roomId) {
        alert("Please enter both your name and a Room ID to join.");
        return;
    }

    console.log(`[Lobby] Attempting to join room: ${roomId} as: ${name}`);
    joinBtn.disabled = true;
    joinBtn.innerText = "Joining...";

    try {
        const response = await fetch('/api/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, room_id: roomId, passcode: passcode })
        });

        if (!response.ok) throw new Error('Registration failed');

        const userData = await response.json();
        console.log("[Lobby] Registration successful:", userData);

        localUserId = userData.user_id;
        localUserName = userData.name;
        localRoomId = userData.room_id;
        localUserRole = userData.role;

        if (localUserRole === 'pastor') {
            document.getElementById('moderation-panel').style.display = 'block';
        } else {
            document.getElementById('member-controls').style.display = 'block';
        }

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
    console.log(`[App] Initializing Sanctuary for Room: ${localRoomId}...`);
    
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    pews = generatePewLayout();
    
    const userRef = ref(db, `services/${localRoomId}/users/${localUserId}`);
    set(userRef, {
        id: localUserId,
        agoraUid: agoraUid,
        name: localUserName,
        role: localUserRole, 
        color: localUserColor,
        x: startX,
        y: startY,
        targetX: startX,
        targetY: startY
    });
    onDisconnect(userRef).remove();

    initializeAgora(agoraUid, localRoomId);

    onValue(ref(db, `services/${localRoomId}/users`), (snapshot) => {
        activeUsers = snapshot.val() || {};
        updateUI();
        if (localUserRole === 'pastor') updateModerationPanel();
    });

    onValue(ref(db, `services/${localRoomId}/users/${localUserId}`), (snapshot) => {
        const userData = snapshot.val();
        if (userData?.canSpeak && localUserRole === 'member') {
            if (localTracks.audioTrack) {
                localTracks.audioTrack.setMuted(false);
                showToast("You are now live!");
                update(ref(db, `services/${localRoomId}/users/${localUserId}`), { canSpeak: false });
            }
        }
    });

    onValue(ref(db, `services/${localRoomId}/pews`), (snapshot) => {
        syncedPews = snapshot.val() || {};
    });

    const chatQuery = query(ref(db, `services/${localRoomId}/chat`), limitToLast(20));
    onValue(chatQuery, (snapshot) => {
        displayMessages(snapshot.val());
    });

    const reactionsRef = query(ref(db, `services/${localRoomId}/reactions`), limitToLast(5));
    onValue(reactionsRef, (snapshot) => {
        const data = snapshot.val();
        if (data) {
            Object.values(data).forEach(reaction => {
                if (Date.now() - reaction.timestamp < 2000) {
                    const user = activeUsers[reaction.userId];
                    if (user) {
                        activeReactions.push({
                            emoji: reaction.emoji,
                            x: user.x,
                            y: user.y - 30,
                            opacity: 1.0,
                            life: 60 
                        });
                    }
                }
            });
        }
    });

    canvas.addEventListener('mousedown', handleCanvasClick);
    document.getElementById('chat-send').addEventListener('click', sendMessage);
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    document.getElementById('raise-hand-btn').addEventListener('click', toggleRaiseHand);
    
    if (localUserRole === 'pastor') {
        const ssBtn = document.getElementById('screen-share-btn');
        ssBtn.style.display = 'flex';
        ssBtn.addEventListener('click', toggleScreenShare);
    }

    const clearRoomBtn = document.getElementById('clear-room-btn');
    if (clearRoomBtn) {
        clearRoomBtn.addEventListener('click', async () => {
            if (confirm("Are you sure you want to clear all data in this room?")) {
                const response = await fetch('/api/clear-room', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ room_id: localRoomId })
                });
                if (response.ok) {
                    showToast("Room cleared successfully.");
                } else {
                    alert("Failed to clear room. Are you unauthorized?");
                }
            }
        });
    }

    requestAnimationFrame(gameLoop);
    setInterval(updateSpatialAudio, 500);

    console.log("[App] Loop Started.");
}

function resizeCanvas() {
    const padding = 20;
    const availableWidth = window.innerWidth - padding;
    const availableHeight = window.innerHeight - padding;
    const aspectRatio = WIDTH / HEIGHT;
    if (availableWidth / availableHeight > aspectRatio) {
        canvas.style.height = `${availableHeight}px`;
        canvas.style.width = `${availableHeight * aspectRatio}px`;
    } else {
        canvas.style.width = `${availableWidth}px`;
        canvas.style.height = `${availableWidth / aspectRatio}px`;
    }
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
}

async function toggleRaiseHand() {
    const userRef = ref(db, `services/${localRoomId}/users/${localUserId}`);
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
    const userRef = ref(db, `services/${localRoomId}/users/${userId}`);
    await update(userRef, { canSpeak: true, handRaised: false });
};

function showToast(message) {
    const toast = document.getElementById('notification-toast');
    toast.innerText = message;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function calculateDistance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

function getVolumeFromDistance(distance) {
    const minDistance = 50;
    const maxDistance = 300;
    if (distance <= minDistance) return 100;
    if (distance >= maxDistance) return 0;
    return 100 * (1 - (distance - minDistance) / (maxDistance - minDistance));
}

function updateSpatialAudio() {
    if (!agoraClient || !activeUsers[localUserId]) return;
    const localUser = activeUsers[localUserId];
    const remoteUsers = agoraClient.remoteUsers;
    remoteUsers.forEach(agoraUser => {
        const firebaseUser = Object.values(activeUsers).find(u => u.agoraUid == agoraUser.uid);
        if (firebaseUser && agoraUser.audioTrack) {
            let volume = 100;
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
    const scaleX = WIDTH / rect.width;
    const scaleY = HEIGHT / rect.height;
    const mouseX = (event.clientX - rect.left) * scaleX;
    const mouseY = (event.clientY - rect.top) * scaleY;
    if (localUserRole === 'member' && mouseY < ALTAR_HEIGHT) return; 

    let seatClicked = false;
    pews.forEach(seat => {
        if (mouseX >= seat.x && mouseX <= seat.x + SEAT_WIDTH &&
            mouseY >= seat.y && mouseY <= seat.y + SEAT_HEIGHT) {
            seatClicked = true;
            const pewRef = ref(db, `services/${localRoomId}/pews/${seat.id}`);
            const currentOccupant = syncedPews[seat.id]?.occupiedBy;
            if (!currentOccupant) {
                update(pewRef, { occupiedBy: localUserId, userName: localUserName });
                update(ref(db, `services/${localRoomId}/users/${localUserId}`), {
                    targetX: seat.x + SEAT_WIDTH / 2,
                    targetY: seat.y + SEAT_HEIGHT / 2
                });
            } else if (currentOccupant === localUserId) {
                set(pewRef, null);
                update(ref(db, `services/${localRoomId}/users/${localUserId}`), { targetX: mouseX, targetY: mouseY });
            }
        }
    });
    if (!seatClicked) {
        update(ref(db, `services/${localRoomId}/users/${localUserId}`), { targetX: mouseX, targetY: mouseY });
    }
}

function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (text) {
        push(ref(db, `services/${localRoomId}/chat`), { name: localUserName, text: text, timestamp: serverTimestamp() });
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
    
    const remoteScreenUser = agoraClient.remoteUsers.find(u => u.uid % 1000 === 0 && u.videoTrack); 
    if (remoteScreenUser && remoteScreenUser.videoTrack) {
        const projectorX = WIDTH / 2 - 150;
        const projectorY = 20;
        const projectorW = 300;
        const projectorH = 100;
        const projectorOverlay = document.getElementById('projector-overlay') || createProjectorOverlay();
        const rect = canvas.getBoundingClientRect();
        const scale = rect.width / WIDTH;
        projectorOverlay.style.left = `${(projectorX * scale) + rect.left}px`;
        projectorOverlay.style.top = `${(projectorY * scale) + rect.top}px`;
        projectorOverlay.style.width = `${projectorW * scale}px`;
        projectorOverlay.style.height = `${projectorH * scale}px`;
        projectorOverlay.style.display = 'block';
        if (!projectorOverlay.hasChildNodes()) {
            remoteScreenUser.videoTrack.play(projectorOverlay);
        }
    } else {
        const overlay = document.getElementById('projector-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    Object.keys(activeUsers).forEach(id => {
        const user = activeUsers[id];
        if (user.x !== user.targetX || user.y !== user.targetY) {
            user.x += (user.targetX - user.x) * 0.1;
            user.y += (user.targetY - user.y) * 0.1;
        }
        drawAvatar(user);
        if (user.agoraUid) {
            const videoBubble = document.getElementById(`player-${user.agoraUid}`);
            if (videoBubble) {
                const rect = canvas.getBoundingClientRect();
                const scale = rect.width / WIDTH;
                videoBubble.style.left = `${(user.x - 25) * scale + rect.left}px`;
                videoBubble.style.top = `${(user.y - 70) * scale + rect.top}px`;
                videoBubble.style.width = `${50 * scale}px`;
                videoBubble.style.height = `${50 * scale}px`;
            }
        }
    });

    activeReactions = activeReactions.filter(r => r.life > 0);
    activeReactions.forEach(r => {
        ctx.globalAlpha = r.opacity;
        ctx.font = '24px serif';
        ctx.fillText(r.emoji, r.x, r.y);
        r.y -= 1;
        r.opacity -= 0.015;
        r.life--;
    });
    ctx.globalAlpha = 1.0;
    requestAnimationFrame(gameLoop);
}

function createProjectorOverlay() {
    const div = document.createElement('div');
    div.id = 'projector-overlay';
    div.style.position = 'fixed';
    div.style.backgroundColor = '#000';
    div.style.zIndex = '4';
    div.style.pointerEvents = 'none';
    div.style.border = '4px solid #34495e';
    document.body.appendChild(div);
    return div;
}

function drawAvatar(user) {
    const radius = 12;
    if (user.role === 'pastor') {
        ctx.strokeStyle = '#ffd700';
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
    
    ctx.fillStyle = '#2c3e50';
    ctx.fillRect(WIDTH / 2 - 150, 20, 300, 100);
    ctx.strokeStyle = '#34495e';
    ctx.lineWidth = 4;
    ctx.strokeRect(WIDTH / 2 - 150, 20, 300, 100);
    ctx.fillStyle = '#fff';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText("VIRTUAL PROJECTOR", WIDTH / 2, 80);

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
    if (userInfo) userInfo.innerText = `${localUserName} | Users Online: ${Object.keys(activeUsers).length}`;
}

async function initializeAgora(uid, channelName) {
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
                playerContainer.style.position = "fixed";
                playerContainer.style.borderRadius = "50%";
                playerContainer.style.overflow = "hidden";
                playerContainer.style.border = "2px solid white";
                playerContainer.style.backgroundColor = "black";
                playerContainer.style.zIndex = "5";
                playerContainer.style.pointerEvents = "none";
                document.getElementById("video-container").append(playerContainer);
                remoteVideoTrack.play(playerContainer);
            }
            if (mediaType === "audio") user.audioTrack.play();
        });
        agoraClient.on("user-unpublished", (user) => {
            const playerContainer = document.getElementById(`player-${user.uid}`);
            if (playerContainer) playerContainer.remove();
        });
        await agoraClient.join(appId, channelName, token, uid);
        localTracks.audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        localTracks.videoTrack = await AgoraRTC.createCameraVideoTrack();
        if (localUserRole === 'pastor') {
            localTracks.audioTrack.setMuted(false);
            showToast("You are live! Your microphone is active.");
        } else {
            localTracks.audioTrack.setMuted(true);
        }
        const localPlayerContainer = document.createElement("div");
        localPlayerContainer.id = `player-${uid}`;
        localPlayerContainer.className = "video-bubble";
        localPlayerContainer.style.position = "fixed";
        localPlayerContainer.style.borderRadius = "50%";
        localPlayerContainer.style.overflow = "hidden";
        localPlayerContainer.style.border = "2px solid #3498db";
        localPlayerContainer.style.backgroundColor = "black";
        localPlayerContainer.style.zIndex = "5";
        localPlayerContainer.style.pointerEvents = "none";
        document.getElementById("video-container").append(localPlayerContainer);
        localTracks.videoTrack.play(localPlayerContainer);
        await agoraClient.publish([localTracks.audioTrack, localTracks.videoTrack]);
    } catch (err) {
        console.error("[Agora] Initialization failed", err);
    }
}

setupLobby();
