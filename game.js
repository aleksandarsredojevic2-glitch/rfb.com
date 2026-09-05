const canvas = document.getElementById("hockeyCanvas");
const ctx = canvas.getContext("2d");
const host = window.location.hostname;
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const port = window.location.port ? `:${window.location.port}` : '';

// Prepoznaje localhost, 127.0.0.1 i privatne LAN opsege (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
const isLocalNetwork = /^(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/.test(host);

const wsUrl = isLocalNetwork ? `ws://${host}:3000` : `wss://icehockeybattlebeta.onrender.com`;

const socket = new WebSocket(wsUrl);

let puck = { x: 1500, y: 750 };
let players = {};
let myId = null;
let isAdmin = false;
let lastLobbySignature = "";
let currentScore = { teamRed: 0, teamBlue: 0 };
let cameraZoom = 1;
let selectedGoalLimit = 5;

const fieldBgImg = new Image();
fieldBgImg.src = "trava.png";
let fieldImgLoaded = false;
fieldBgImg.onload = function() { fieldImgLoaded = true; };

const standsBgImg = new Image();
standsBgImg.src = "tribine.png";
let standsPattern = null;
standsBgImg.onload = function() { standsPattern = ctx.createPattern(standsBgImg, 'repeat'); };

const rplayerImg = new Image();
rplayerImg.src = "rplayer.png";
let rplayerLoaded = false;
rplayerImg.onload = function() { rplayerLoaded = true; };

const bplayerImg = new Image();
bplayerImg.src = "bplayer.png";
let bplayerLoaded = false;
bplayerImg.onload = function() { bplayerLoaded = true; };

let worldInfo = {
    WORLD_WIDTH: 3000,
    WORLD_HEIGHT: 1500,
    ICE_WIDTH: 2600,
    ICE_HEIGHT: 1200,
    GOAL_WIDTH: 190,
    GOAL_NET_DEPTH: 45,
    T: 35
};
let WORLD_WIDTH = worldInfo.WORLD_WIDTH;
let WORLD_HEIGHT = worldInfo.WORLD_HEIGHT;
let iceScratches = [];
let animState = {};

function getSpecs() {
    const w = worldInfo;
    const startX = (WORLD_WIDTH - w.ICE_WIDTH) / 2;
    const startY = (WORLD_HEIGHT - w.ICE_HEIGHT) / 2;
    const goalLineLeft = startX;
    const goalLineRight = startX + w.ICE_WIDTH;

    const penaltyDepth = w.ICE_WIDTH * 0.16;
    const penaltyHeight = w.ICE_HEIGHT * 0.56;
    const goalBoxDepth = w.ICE_WIDTH * 0.055;
    const goalBoxHeight = w.ICE_HEIGHT * 0.28;
    const penaltySpotDist = w.ICE_WIDTH * 0.115;

    return {
        scale: 1,
        left: startX,
        right: startX + w.ICE_WIDTH,
        top: startY,
        bottom: startY + w.ICE_HEIGHT,
        goalLineLeft: goalLineLeft,
        goalLineRight: goalLineRight,
        centerCircleR: w.ICE_HEIGHT * 0.19,
        cornerArcR: 24,
        penaltyDepth: penaltyDepth,
        penaltyHeight: penaltyHeight,
        goalBoxDepth: goalBoxDepth,
        goalBoxHeight: goalBoxHeight,
        penaltySpotDist: penaltySpotDist,
        goal: {
            depth: w.GOAL_NET_DEPTH,
            h: w.GOAL_WIDTH,
            y: startY + (w.ICE_HEIGHT / 2) - (w.GOAL_WIDTH / 2)
        }
    };
}

function showChat() {
    document.getElementById('chatInputContainer').style.display = 'block';
    document.getElementById('chatBox').style.display = 'block';
    document.getElementById('gameTopBar').style.display = 'flex';
}

function isInGame() {
    return document.getElementById('screen-login').style.display === 'none' &&
           document.getElementById('screen-rooms').style.display === 'none' &&
           document.getElementById('screen-lobby').style.display === 'none';
}

function closeAllGamePanels() {
    document.getElementById('gameMenuPanel').style.display = 'none';
    document.getElementById('gameSettingsPanel').style.display = 'none';
    document.getElementById('gameControlsPanel').style.display = 'none';
}

function toggleMenuPanel() {
    if (!isInGame()) return;
    const panel = document.getElementById('gameMenuPanel');
    const isOpen = panel.style.display === 'block';
    closeAllGamePanels();
    panel.style.display = isOpen ? 'none' : 'block';
}

function toggleSettingsPanel() {
    if (!isInGame()) return;
    const panel = document.getElementById('gameSettingsPanel');
    const isOpen = panel.style.display === 'block';
    closeAllGamePanels();
    panel.style.display = isOpen ? 'none' : 'block';
}

function toggleControlsPanel() {
    if (!isInGame()) return;
    const panel = document.getElementById('gameControlsPanel');
    const isOpen = panel.style.display === 'block';
    closeAllGamePanels();
    panel.style.display = isOpen ? 'none' : 'block';
}

function confirmStopGame() {
    if (!isAdmin) return;
    if (confirm("Da li sigurno želiš da prekineš igru?")) {
        socket.send(JSON.stringify({ type: 'stop-game' }));
    }
}

function setCameraZoom(value) {
    cameraZoom = value;
    document.querySelectorAll('#zoomOptions button').forEach(btn => {
        btn.classList.toggle('active', parseFloat(btn.dataset.zoom) === value);
    });
}

function setGoalLimit(n) {
    if (!isAdmin) return;
    selectedGoalLimit = n;
    document.querySelectorAll('.limit-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.limit) === n);
    });
}

function updateMenuPlayerList() {
    const listRed = document.getElementById('menu-list-red');
    const listBlue = document.getElementById('menu-list-blue');
    const listSpec = document.getElementById('menu-list-spectators');
    if (!listRed || !listBlue || !listSpec) return;

    listRed.innerHTML = "";
    listBlue.innerHTML = "";
    listSpec.innerHTML = "";

    Object.values(players).forEach(p => {
        let li = document.createElement('li');
        li.innerText = p.name;
        if (p.team === 'red') listRed.appendChild(li);
        else if (p.team === 'blue') listBlue.appendChild(li);
        else listSpec.appendChild(li);
    });
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (document.activeElement === document.getElementById('chatInput')) {
            document.activeElement.blur();
            return;
        }
        if (!isInGame()) return;
        const menuOpen = document.getElementById('gameMenuPanel').style.display === 'block';
        const settingsOpen = document.getElementById('gameSettingsPanel').style.display === 'block';
        const controlsOpen = document.getElementById('gameControlsPanel').style.display === 'block';
        if (menuOpen || settingsOpen || controlsOpen) {
            closeAllGamePanels();
        } else {
            toggleMenuPanel();
        }
    }
});

setCameraZoom(1);

let goalBannerTimeout = null;
function showGoalBanner(team) {
    const banner = document.getElementById('goalBanner');
    banner.innerText = "GOAAAAAAAAAL!!!!!";
    banner.style.color = team === 'red' ? '#FF4A4A' : '#4d94ff';
    banner.style.display = 'block';
    clearTimeout(goalBannerTimeout);
    goalBannerTimeout = setTimeout(() => { banner.style.display = 'none'; }, 2000);
}

function drawScore() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const w = 400;
    const h = 50;
    const x = canvas.width / 2 - w / 2;
    const y = 0.5;
    const lineW = 6;

    ctx.fillStyle = "#ff4d4d";
    ctx.fillRect(x, y, lineW, h);

    ctx.fillStyle = "blue";
    ctx.fillRect(x + w - lineW, y, lineW, h);

    const secW = (w - (2 * lineW)) / 3;
    const startX = x + lineW;

    ctx.fillStyle = "#61616180";
    ctx.fillRect(startX, y, secW, h);

    ctx.fillStyle = "#A6A6A650";
    ctx.fillRect(startX + secW, y, secW, h);

    ctx.fillStyle = "#61616180";
    ctx.fillRect(startX + 2 * secW, y, secW, h);

    ctx.font = "bold 22px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "white";

    ctx.fillText("HOME", startX + secW/2, y + h/2);
    ctx.fillStyle = "#1a1a1a";
    ctx.fillText(`${currentScore.teamRed} - ${currentScore.teamBlue}`, startX + secW + secW/2, y + h/2);
    ctx.fillStyle = "white";
    ctx.fillText("AWAY", startX + 2 * secW + secW/2, y + h/2);

    ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function showScreen(id) {
    ['screen-login', 'screen-rooms', 'screen-lobby'].forEach(s => {
        document.getElementById(s).style.display = (s === id) ? 'flex' : 'none';
    });
}

function renderRoomList(roomList) {
    const container = document.getElementById('room-list-container');
    container.innerHTML = "";
    if (!roomList || roomList.length === 0) {
        container.innerHTML = "<p style='color:white; text-align:center;'> </p>";
        return;
    }
    roomList.forEach(room => {
        const div = document.createElement('div');
        div.className = 'room-entry';
        div.innerHTML = `<span>RFB | Hosted by ${room.hostName}<br><small style="font-weight:normal; opacity:0.75;">${room.playerCount} igrača · ${room.gameState}</small></span>`;
        const btn = document.createElement('button');
        btn.innerText = "JOIN";
        btn.onclick = () => joinExistingRoom(room.id);
        div.appendChild(btn);
        container.appendChild(div);
    });
}

function joinExistingRoom(roomId) {
    const nick = document.getElementById('nameInput').value || "Guest";
    socket.send(JSON.stringify({ type: 'join-room', room: roomId, name: nick }));
    showScreen('screen-lobby');
}

socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'welcome') myId = data.myId;

    if (data.type === 'world-info') {
        worldInfo = data;
        WORLD_WIDTH = data.WORLD_WIDTH;
        WORLD_HEIGHT = data.WORLD_HEIGHT;
    }

    if (data.type === 'room-list') {
        renderRoomList(data.rooms);
    }

    if (data.type === 'room-created') {
        socket.send(JSON.stringify({ type: 'join-room', room: data.roomId, name: document.getElementById('nameInput').value }));
        showScreen('screen-lobby');
    }

    if (data.type === 'game-started') {
        showScreen(null);
        showChat();
    }

    if (data.type === 'goal-scored') {
        showGoalBanner(data.team);
    }

    if (data.type === 'game-over') {
        alert("Pobednik: " + data.winner);
        document.getElementById('chatBox').style.display = 'none';
        document.getElementById('chatInputContainer').style.display = 'none';
        document.getElementById('gameTopBar').style.display = 'none';
        closeAllGamePanels();
        showScreen('screen-lobby');
    }

    if (data.type === 'game-stopped') {
        alert("Igra je prekinuta od strane hosta.");
        document.getElementById('chatBox').style.display = 'none';
        document.getElementById('chatInputContainer').style.display = 'none';
        document.getElementById('gameTopBar').style.display = 'none';
        closeAllGamePanels();
        showScreen('screen-lobby');
    }

    if (data.type === 'field-event') {
        const chatBox = document.getElementById('chatBox');
        const msg = document.createElement('div');
        msg.style.color = '#ffd54f';
        msg.style.fontWeight = 'bold';
        msg.innerText = data.text;
        chatBox.appendChild(msg);
        chatBox.scrollTop = chatBox.scrollHeight;
        document.getElementById('chatBox').style.display = 'block';
    }

    if (data.type === 'chat') {
        const chatBox = document.getElementById('chatBox');
        const msg = document.createElement('div');
        const senderName = players[data.senderId] ? players[data.senderId].name : "Nepoznat";
        msg.innerHTML = `<b>${senderName}:</b> ${data.text}`;
        chatBox.appendChild(msg);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    if (data.type === 'update') {
        puck.x = data.puck.x; puck.y = data.puck.y;
        players = data.players;
        currentScore = data.score;

        const startBtn = document.getElementById('start-btn');
        const goalLimitSelector = document.getElementById('goal-limit-selector');
        const stopGameBtn = document.getElementById('stopGameBtn');
        isAdmin = (data.adminId === myId);
        if (startBtn) startBtn.style.display = isAdmin ? "block" : "none";
        if (goalLimitSelector) goalLimitSelector.style.display = isAdmin ? "flex" : "none";
        if (stopGameBtn) stopGameBtn.style.display = isAdmin ? "flex" : "none";

        const lobbySignature = isAdmin + '|' + Object.entries(players).map(([id, p]) => id + ':' + p.name + ':' + p.team).join(',');

        if (lobbySignature !== lastLobbySignature) {
            lastLobbySignature = lobbySignature;

            const listRed = document.getElementById('list-red');
            const listBlue = document.getElementById('list-blue');
            const listSpec = document.getElementById('list-spectators');

            listRed.innerHTML = "";
            listBlue.innerHTML = "";
            listSpec.innerHTML = "";

            const teamOrder = ['red', 'spectator', 'blue'];

            Object.entries(players).forEach(([id, p]) => {
                let li = document.createElement('li');

                if (isAdmin) {
                    li.style.display = 'flex';
                    li.style.alignItems = 'center';
                    li.style.justifyContent = 'center';
                    li.style.gap = '4px';

                    const currentIndex = teamOrder.indexOf(p.team);

                    let leftBtn = document.createElement('button');
                    leftBtn.className = 'admin-move-btn';
                    leftBtn.innerText = '◀';
                    leftBtn.title = 'Pomeri ulevo (ka RED)';
                    leftBtn.disabled = currentIndex <= 0;
                    leftBtn.style.opacity = leftBtn.disabled ? '0.3' : '1';
                    leftBtn.onclick = () => adminAssignTeam(id, teamOrder[Math.max(0, currentIndex - 1)]);
                    li.appendChild(leftBtn);

                    let nameSpan = document.createElement('span');
                    nameSpan.innerText = p.name;
                    li.appendChild(nameSpan);

                    let rightBtn = document.createElement('button');
                    rightBtn.className = 'admin-move-btn';
                    rightBtn.innerText = '▶';
                    rightBtn.title = 'Pomeri udesno (ka BLUE)';
                    rightBtn.disabled = currentIndex >= teamOrder.length - 1;
                    rightBtn.style.opacity = rightBtn.disabled ? '0.3' : '1';
                    rightBtn.onclick = () => adminAssignTeam(id, teamOrder[Math.min(teamOrder.length - 1, currentIndex + 1)]);
                    li.appendChild(rightBtn);
                } else {
                    li.innerText = p.name;
                }

                if (p.team === 'red') listRed.appendChild(li);
                else if (p.team === 'blue') listBlue.appendChild(li);
                else listSpec.appendChild(li);
            });

            updateMenuPlayerList();
        }
    }
}

function drawGoalNet(x0, y0, y1, depth, dir) {
    const x1 = x0 + dir * depth;
    const left = Math.min(x0, x1), right = Math.max(x0, x1);
    const height = y1 - y0;

    let shadowGrad = ctx.createLinearGradient(x0, 0, x1, 0);
    shadowGrad.addColorStop(0, "rgba(0,0,0,0.05)");
    shadowGrad.addColorStop(1, "rgba(0,0,0,0.4)");
    ctx.fillStyle = shadowGrad;
    ctx.fillRect(left, y0, right - left, height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, y0, right - left, height);
    ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    const step = 11;
    for (let d = -height; d < (right - left) + height; d += step) {
        ctx.beginPath();
        ctx.moveTo(left + d, y0);
        ctx.lineTo(left + d + height, y1);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(left + d, y1);
        ctx.lineTo(left + d + height, y0);
        ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = "white";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x0, y1);
    ctx.stroke();

    ctx.fillStyle = "white";
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1.2;
    [y0, y1].forEach(y => {
        ctx.beginPath();
        ctx.arc(x0, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    });
}

function drawVectorField() {
    const s = getSpecs(); const g = s.goal;
    const centerY = WORLD_HEIGHT / 2;
    const centerX = WORLD_WIDTH / 2;

    if (standsPattern) {
        ctx.fillStyle = standsPattern;
        ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    } else {
        ctx.fillStyle = "#2b2f38";
        ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    }

    ctx.fillStyle = "#113311";
    ctx.fillRect(s.left, s.top, s.right - s.left, s.bottom - s.top);

    if (fieldImgLoaded) {
        ctx.drawImage(fieldBgImg, s.left, s.top, s.right - s.left, s.bottom - s.top);
    }

    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 4 * s.scale;

    ctx.strokeRect(s.left, s.top, s.right - s.left, s.bottom - s.top);

    ctx.beginPath();
    ctx.moveTo(centerX, s.top);
    ctx.lineTo(centerX, s.bottom);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(centerX, centerY, s.centerCircleR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.arc(centerX, centerY, 4 * s.scale, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 3 * s.scale;
    ctx.beginPath(); ctx.arc(s.left, s.top, s.cornerArcR, 0, Math.PI / 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.right, s.top, s.cornerArcR, Math.PI / 2, Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.left, s.bottom, s.cornerArcR, -Math.PI / 2, 0); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.right, s.bottom, s.cornerArcR, Math.PI, Math.PI * 1.5); ctx.stroke();

    ctx.lineWidth = 4 * s.scale;
    ctx.strokeRect(s.left, centerY - s.penaltyHeight / 2, s.penaltyDepth, s.penaltyHeight);
    ctx.strokeRect(s.left, centerY - s.goalBoxHeight / 2, s.goalBoxDepth, s.goalBoxHeight);
    ctx.beginPath(); ctx.arc(s.left + s.penaltySpotDist, centerY, 3.5 * s.scale, 0, Math.PI * 2); ctx.fill();

    const penaltyArcR = s.centerCircleR * 0.95;
    const dxLeft = s.penaltyDepth - s.penaltySpotDist;
    const arcAngleLeft = Math.acos(Math.min(1, Math.max(-1, dxLeft / penaltyArcR)));
    ctx.beginPath();
    ctx.arc(s.left + s.penaltySpotDist, centerY, penaltyArcR, -arcAngleLeft, arcAngleLeft);
    ctx.stroke();

    ctx.strokeRect(s.right - s.penaltyDepth, centerY - s.penaltyHeight / 2, s.penaltyDepth, s.penaltyHeight);
    ctx.strokeRect(s.right - s.goalBoxDepth, centerY - s.goalBoxHeight / 2, s.goalBoxDepth, s.goalBoxHeight);
    ctx.beginPath(); ctx.arc(s.right - s.penaltySpotDist, centerY, 3.5 * s.scale, 0, Math.PI * 2); ctx.fill();

    const dxRight = s.penaltyDepth - s.penaltySpotDist;
    const arcAngleRight = Math.acos(Math.min(1, Math.max(-1, dxRight / penaltyArcR)));
    ctx.beginPath();
    ctx.arc(s.right - s.penaltySpotDist, centerY, penaltyArcR, Math.PI - arcAngleRight, Math.PI + arcAngleRight);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    ctx.font = `bold ${Math.floor(47 * s.scale)}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("", centerX, centerY + 4);

    drawGoalNet(s.left, g.y, g.y + g.h, g.depth, -1);
    drawGoalNet(s.right, g.y, g.y + g.h, g.depth, 1);
}

function goToRoomScreen() {
    const nick = document.getElementById('nameInput').value;
    if (!nick) return alert("Unesi ime!");
    showScreen('screen-rooms');
    socket.send(JSON.stringify({ type: 'list-rooms' }));
}
function changeTeam(team) {
    const nick = document.getElementById('nameInput').value || "Guest";
    if ((team === 'red' || team === 'blue') && !isAdmin) {
        alert("Samo host može da ubacuje igrače u tim.");
        return;
    }
    socket.send(JSON.stringify({ type: 'set-team', team: team, name: nick }));
}

function adminAssignTeam(targetId, team) {
    if (!isAdmin) return;
    socket.send(JSON.stringify({ type: 'admin-set-team', targetId: targetId, team: team }));
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
function createNewRoom() {
    const nick = document.getElementById('nameInput').value || "Guest";
    socket.send(JSON.stringify({ type: 'create-room', name: nick }));
}

function sendStart() {
    socket.send(JSON.stringify({ type: 'start-game', limit: selectedGoalLimit }));
}
document.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        if (document.activeElement === chatInput) {
            const text = chatInput.value.trim();
            if (text !== "") {
                socket.send(JSON.stringify({ type: 'chat', text: text }));
                chatInput.value = "";
            }
            chatInput.blur();
        } else {
            document.getElementById('chatBox').style.display = 'block';
            document.getElementById('chatInputContainer').style.display = 'block';
            chatInput.focus();
        }
    }
});

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (document.getElementById('screen-login').style.display !== 'none' ||
        document.getElementById('screen-rooms').style.display !== 'none' ||
        document.getElementById('screen-lobby').style.display !== 'none') {

        requestAnimationFrame(draw);
        return;
    }

    let me = players[myId];
    let hasPosition = me && me.x != null && me.y != null;

    let targetX = hasPosition ? me.x : WORLD_WIDTH / 2;
    let targetY = hasPosition ? me.y : WORLD_HEIGHT / 2;
    const viewW = canvas.width * cameraZoom;
    const viewH = canvas.height * cameraZoom;

    let camX = targetX - viewW / 2;
    let camY = targetY - viewH / 2;

    camX = Math.max(0, Math.min(camX, WORLD_WIDTH - viewW));
    camY = Math.max(0, Math.min(camY, WORLD_HEIGHT - viewH));

    ctx.save();
    ctx.scale(1 / cameraZoom, 1 / cameraZoom);
    ctx.translate(-camX, -camY);

    drawVectorField();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(puck.x, puck.y, 5.8, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = "black";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(puck.x, puck.y, 6.1, 0, Math.PI * 2); ctx.stroke();

    for (let id in players) {
        let p = players[id];
        if (p.team !== 'red' && p.team !== 'blue') continue;

        const img = (p.team === 'red') ? rplayerImg : bplayerImg;
        const imgLoaded = (p.team === 'red') ? rplayerLoaded : bplayerLoaded;
        const size = 88;

        if (imgLoaded) {
            const fx = p.facingX ?? 0;
            const fy = p.facingY ?? 1;
            const angle = Math.atan2(-fx, fy);

            if (!animState[id]) animState[id] = { lastX: p.x, lastY: p.y, dist: 0, lastMoveTime: 0 };
            const st = animState[id];
            const stepDx = p.x - st.lastX, stepDy = p.y - st.lastY;
            const stepDist = Math.sqrt(stepDx * stepDx + stepDy * stepDy);
            st.lastX = p.x; st.lastY = p.y;

            const now = performance.now();
            if (stepDist > 0.05) {
                st.dist += stepDist;
                st.lastMoveTime = now;
            }

            const strideLength = 45;
            const isMoving = (now - st.lastMoveTime) < 150;
            const phase = (st.dist / strideLength) * Math.PI;
            const mirrored = isMoving && (Math.floor(st.dist / strideLength) % 2 === 1);
            const squash = isMoving ? 1 - Math.abs(Math.sin(phase)) * 0.10 : 1;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(angle);
            ctx.scale(mirrored ? -1 : 1, squash);
            ctx.drawImage(img, -size / 2, -size / 2, size, size);
            ctx.restore();
        } else {
            ctx.fillStyle = (p.team === 'red') ? "#FF4A4A" : "#4d94ff";
            ctx.beginPath();
            ctx.arc(p.x, p.y, 17.7, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = "black";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 17.9, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.fillStyle = "black";
        ctx.font = "bold 14px Arial";
        ctx.textAlign = "center";
        ctx.fillText(p.name, p.x, p.y - 28);
        if (p.chatMessage) {
            ctx.fillStyle = "rgba(0, 0, 0)";
            ctx.fillRect(p.x - 60, p.y - 70, 120, 30);

            ctx.fillStyle = "black";
            ctx.font = "12px Arial";
            ctx.textAlign = "center";
            ctx.fillText(p.chatMessage, p.x, p.y - 50);
        }
    }

    ctx.restore();

    drawScore();

    requestAnimationFrame(draw);
}
let keys = {};

window.addEventListener("keydown", (e) => {
    if (document.activeElement.id === 'chatInput') return;

    if (e.code === 'KeyZ') {
        if (keys[e.code]) return;
        keys[e.code] = true;
        socket.send(JSON.stringify({ type: 'shoot' }));
        return;
    }

    if (e.code === 'Space' || e.code === 'KeyX') {
        if (keys[e.code]) return;
        keys[e.code] = true;
        socket.send(JSON.stringify({ type: 'pass' }));
        return;
    }

    if (keys[e.code]) return;
    keys[e.code] = true;
    socket.send(JSON.stringify({ type: 'key-down', key: e.code }));
});

window.addEventListener("keyup", (e) => {
    if (e.code === 'KeyZ' || e.code === 'Space' || e.code === 'KeyX') {
        keys[e.code] = false;
        return;
    }

    keys[e.code] = false;
    socket.send(JSON.stringify({ type: 'key-up', key: e.code }));
});

resize();
draw();
