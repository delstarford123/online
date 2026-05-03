import React, { useRef, useEffect, useState } from 'react';
import { ref, set, onValue, update, onDisconnect } from "firebase/database";
import { db } from '../firebase';

const SanctuaryMap = () => {
  const canvasRef = useRef(null);
  const requestRef = useRef();
  
  // Unique User ID for this session
  const [userId] = useState("user_" + Math.random().toString(36).substr(2, 9));
  
  // States
  const [localAvatar, setLocalAvatar] = useState({
    x: 400, y: 550, targetX: 400, targetY: 550, color: '#3498db', name: 'Me'
  });
  const [remoteUsers, setRemoteUsers] = useState({});

  const GRID_WIDTH = 800;
  const GRID_HEIGHT = 600;
  const SEAT_SIZE = 30;
  const AVATAR_RADIUS = 12;

  const seats = [
    { id: 1, x: 100, y: 150, label: '1A', status: 'empty' },
    { id: 2, x: 150, y: 150, label: '1B', status: 'occupied' },
    { id: 3, x: 200, y: 150, label: '1C', status: 'empty' },
    { id: 4, x: 100, y: 250, label: '2A', status: 'empty' },
    { id: 5, x: 450, y: 200, label: 'Row A', status: 'empty', width: 250, height: 40 },
  ];

  /**
   * Firebase Functions
   */
  const joinChurch = (userId, initialX, initialY) => {
    const userRef = ref(db, `rooms/main_sanctuary/users/${userId}`);
    set(userRef, {
      id: userId,
      x: initialX,
      y: initialY,
      targetX: initialX,
      targetY: initialY,
      color: '#' + Math.floor(Math.random()*16777215).toString(16),
      name: `User_${userId.substr(5,3)}`,
      lastActive: Date.now()
    });
    // Remove user when they disconnect
    onDisconnect(userRef).remove();
  };

  const updatePosition = (userId, newX, newY) => {
    const userRef = ref(db, `rooms/main_sanctuary/users/${userId}`);
    update(userRef, {
      targetX: newX,
      targetY: newY,
      lastActive: Date.now()
    });
  };

  useEffect(() => {
    // 1. Join Room
    joinChurch(userId, localAvatar.x, localAvatar.y);

    // 2. Listen for all users
    const usersRef = ref(db, 'rooms/main_sanctuary/users');
    const unsubscribe = onValue(usersRef, (snapshot) => {
      const data = snapshot.val() || {};
      setRemoteUsers(data);
    });

    return () => unsubscribe();
  }, [userId]);

  /**
   * Animation & Rendering
   */
  const animate = () => {
    setLocalAvatar(prev => {
      const dx = prev.targetX - prev.x;
      const dy = prev.targetY - prev.y;
      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return { ...prev, x: prev.targetX, y: prev.targetY };
      return { ...prev, x: prev.x + dx * 0.1, y: prev.y + dy * 0.1 };
    });
    requestRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef.current);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Clear & Draw Static Map
    ctx.clearRect(0, 0, GRID_WIDTH, GRID_HEIGHT);
    ctx.fillStyle = '#f9f9f9'; ctx.fillRect(0,0, GRID_WIDTH, GRID_HEIGHT);
    
    // Draw Seats
    seats.forEach(seat => {
      ctx.fillStyle = seat.status === 'occupied' ? '#e74c3c' : '#2ecc71';
      ctx.fillRect(seat.x, seat.y, seat.width || SEAT_SIZE, seat.height || SEAT_SIZE);
    });

    // Draw Other Users (interpolating their movement locally based on their targetX/Y)
    Object.keys(remoteUsers).forEach(id => {
      if (id === userId) return; // Skip local
      const u = remoteUsers[id];
      
      // Basic remote interpolation (simple version: draw at reported target for now)
      // For a smoother look, you'd store remote positions in local state and lerp them too
      ctx.beginPath();
      ctx.arc(u.targetX, u.targetY, AVATAR_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = u.color || '#95a5a6';
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#000'; ctx.fillText(u.name, u.targetX, u.targetY - 20);
    });

    // Draw Local Avatar
    ctx.beginPath();
    ctx.arc(localAvatar.x, localAvatar.y, AVATAR_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = localAvatar.color;
    ctx.fill();
    ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#000'; ctx.fillText("YOU", localAvatar.x, localAvatar.y - 20);

  }, [localAvatar, remoteUsers]);

  const handleCanvasClick = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const clickedSeat = seats.find(s => 
      x >= s.x && x <= s.x + (s.width || SEAT_SIZE) && 
      y >= s.y && y <= s.y + (s.height || SEAT_SIZE)
    );

    if (clickedSeat && clickedSeat.status === 'empty') {
      const tx = clickedSeat.x + (clickedSeat.width || SEAT_SIZE) / 2;
      const ty = clickedSeat.y + (clickedSeat.height || SEAT_SIZE) / 2;
      
      // Update Local Target
      setLocalAvatar(prev => ({ ...prev, targetX: tx, targetY: ty }));
      // Sync to Firebase
      updatePosition(userId, tx, ty);
    }
  };

  return (
    <div style={{ textAlign: 'center' }}>
      <h2>Multiplayer Church Sanctuary</h2>
      <canvas ref={canvasRef} width={GRID_WIDTH} height={GRID_HEIGHT} onClick={handleCanvasClick} style={{ border: '1px solid #ccc' }} />
      <p>Users Online: {Object.keys(remoteUsers).length}</p>
    </div>
  );
};

export default SanctuaryMap;
