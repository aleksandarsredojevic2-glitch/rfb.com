const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Matter = require('matter-js');2

function generateRandomId() {
    return Math.random().toString(36).substr(2, 9);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

let rooms = {};
let players = {};

const WORLD_WIDTH = 3000;
const WORLD_HEIGHT = 1500;

// Dimenzije SAMOG terena (linije igrališta). Sada je gol-linija TAČNO na ivici
// terena (kao u pravom fudbalu), za razliku od hokeja gde je gol bio uvučen unutra.
const ICE_WIDTH = 2600;
const ICE_HEIGHT = 1200;
const startX = (WORLD_WIDTH - ICE_WIDTH) / 2;
const startY = (WORLD_HEIGHT - ICE_HEIGHT) / 2;

const T = 35;           // debljina spoljne "sigurnosne" ograde sveta (ne terena!)
const GOAL_WIDTH = 190;  // širina gol-okvira (zona u kojoj lopta mora biti da bi bio gol)
const GOAL_NET_DEPTH = 45; // koliko duboko IZVAN terena vizuelno/fizički ide gol-mreža

// Margina oko terena (prostor za aut-liniju, kornere, trčanje van linija) -
// automatski proizilazi iz razlike WORLD i ICE dimenzija.
const FIELD_LEFT = startX;
const FIELD_RIGHT = startX + ICE_WIDTH;
const FIELD_TOP = startY;
const FIELD_BOTTOM = startY + ICE_HEIGHT;

// --- BROADCAST HELPERI ---

function broadcastToRoom(roomId, messageObj) {
    const payload = JSON.stringify(messageObj);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
            client.send(payload);
        }
    });
}

function getRoomList() {
    return Object.keys(rooms).map(id => {
        const playerCount = Object.values(players).filter(p => p.roomId === id).length;
        return {
            id: id,
            playerCount: playerCount,
            gameState: rooms[id].gameState
        };
    });
}

function broadcastRoomList() {
    const payload = JSON.stringify({ type: 'room-list', rooms: getRoomList() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

// --- SVET / FIZIKA ---

function createRoom(roomId, adminId) {
    const engine = Matter.Engine.create();
    engine.world.gravity.y = 0;
    setupWorld(engine.world);

    engine.world.bodies.forEach(body => {
        if (body.isStatic) {
            body.friction = 0;
            body.frictionStatic = 0;
            body.restitution = 0.6; // fallback vrednost, u praksi je prepisuje handler ispod
        }
    });

    // Odskok se podešava PO PARU tela koja se sudaraju (ne globalno po telu),
    // jer Matter.js inače uzima max(restitucijaA, restitucijaB) za SVE parove istog tela.
    // Ovim rešavamo da isti zid različito reaguje na loptu i na igrača.
    // Ovde takođe pratimo koji je TIM poslednji dodirnuo loptu - bitno za
    // odlučivanje da li je aut/korner/gol-aut posle izlaska lopte iz igre.
    function applyCustomBounce(event) {
        event.pairs.forEach(pair => {
            const a = pair.bodyA.label;
            const b = pair.bodyB.label;

            if ((a === 'puck' && b === 'wall') || (a === 'wall' && b === 'puck')) {
                pair.restitution = 0.92; // lopta se JAKO odbija od spoljne ograde

            } else if ((a === 'player' && b === 'wall') || (a === 'wall' && b === 'player')) {
                pair.restitution = 0; // igrač se UOPŠTE ne odbija od ograde

            } else if ((a === 'puck' && b === 'player') || (a === 'player' && b === 'puck')) {
                pair.restitution = 0; // lopta se ne odbija od igrača - igrač je lepo vodi

                const playerBody = a === 'player' ? pair.bodyA : pair.bodyB;
                const currentRoom = rooms[roomId];
                if (currentRoom && playerBody.customTeam) {
                    currentRoom.lastToucherTeam = playerBody.customTeam;
                }
            }
        });
    }
    Matter.Events.on(engine, 'collisionStart', applyCustomBounce);
    Matter.Events.on(engine, 'collisionActive', applyCustomBounce);

    const puck = Matter.Bodies.circle(1500, 750, 6, {
        restitution: 0.1,
        friction: 0.05,
        frictionAir: 0.03,
        mass: 0.04,
        label: 'puck'
    });
    Matter.World.add(engine.world, puck);

    rooms[roomId] = {
        engine: engine,
        adminId: adminId,
        puck: puck,
        isResetting: false,
        score: { teamRed: 0, teamBlue: 0 },
        gameState: 'LOBBY',
        goalLimit: 5,
        lastToucherTeam: null, // koji je tim poslednji dodirnuo loptu (za aut/korner/gol-aut pravila)
        ballCarrierId: null,   // koji igrač trenutno "vodi" loptu (dribbling)
        releaseUntil: 0        // dok je Date.now() < ovo, niko ne moze da "zalepi" loptu (posle suta)
    };
}

function resetRoom(roomId) {
    let room = rooms[roomId];
    if (!room || room.isResetting) return;
    room.isResetting = true;

    Matter.Body.setPosition(room.puck, { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 });
    Matter.Body.setVelocity(room.puck, { x: 0, y: 0 });
    room.lastToucherTeam = null;
    room.ballCarrierId = null;
    room.releaseUntil = 0;

    for (let id in players) {
        let p = players[id];
        if (p.roomId === roomId && p.body) {
            if (p.team === 'red') {
                Matter.Body.setPosition(p.body, { x: WORLD_WIDTH / 2 - 400, y: WORLD_HEIGHT / 2 + (Math.random() * 200 - 100) });
            } else if (p.team === 'blue') {
                Matter.Body.setPosition(p.body, { x: WORLD_WIDTH / 2 + 400, y: WORLD_HEIGHT / 2 + (Math.random() * 200 - 100) });
            } else {
                Matter.Body.setPosition(p.body, { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 });
            }
            Matter.Body.setVelocity(p.body, { x: 0, y: 0 });
        }
    }

    setTimeout(() => { room.isResetting = false; }, 500);
}

// Postavlja loptu na dato mesto sa nultom brzinom - koristi se za aut/korner/gol-aut
// (za razliku od resetRoom, ovo NE pomera igrače - to je "brzi" restart kao u arkadnom fudbalu).
function placeBall(room, x, y) {
    Matter.Body.setPosition(room.puck, { x, y });
    Matter.Body.setVelocity(room.puck, { x: 0, y: 0 });
    room.ballCarrierId = null;
}

// Upravlja fizičkim telom igrača u zavisnosti od tima.
// Spectator NEMA telo na terenu (ne postoji na terenu, ne sudara se sa loptom/igračima).
// Telo se pravi tek kad igrač stvarno uđe u red/blue, i uklanja se čim ode u spectate.
function setPlayerTeam(p, room, team) {
    if (team === p.team) return;

    if (team === 'spectator') {
        if (p.body && room) {
            Matter.World.remove(room.engine.world, p.body);
        }
        p.body = null;
        p.team = 'spectator';

    } else if (team === 'red' || team === 'blue') {
        p.team = team;
        if (!p.body && room) {
            let spawnX = team === 'red' ? (WORLD_WIDTH / 2 - 400) : (WORLD_WIDTH / 2 + 400);
            let spawnY = WORLD_HEIGHT / 2 + (Math.random() * 200 - 100);
            let body = Matter.Bodies.circle(spawnX, spawnY, 11, { restitution: 0.01, frictionAir: 0.2, density: 0.002, inertia: Infinity, label: 'player' });
            body.customTeam = team;
            p.body = body;
            Matter.World.add(room.engine.world, body);
        } else if (p.body) {
            // Telo već postoji (igrač je prebačen iz red u blue ili obrnuto) - samo osveži tim na telu
            p.body.customTeam = team;
        }
    }
}

// Spoljna "sigurnosna" ograda sveta - NIJE ivica terena! Teren nema zidove
// (kao u pravom fudbalu - lopta koja izađe van linije se ne odbija, nego se
// proglašava aut/korner/gol-aut). Ova ograda je daleko van terena i postoji
// samo da lopta/igrač ne odlete u beskonačnost.
function setupWorld(world) {
    Matter.World.add(world, [
        Matter.Bodies.rectangle(WORLD_WIDTH / 2, -T / 2, WORLD_WIDTH, T, { isStatic: true, label: 'wall' }),
        Matter.Bodies.rectangle(WORLD_WIDTH / 2, WORLD_HEIGHT + T / 2, WORLD_WIDTH, T, { isStatic: true, label: 'wall' }),
        Matter.Bodies.rectangle(-T / 2, WORLD_HEIGHT / 2, T, WORLD_HEIGHT, { isStatic: true, label: 'wall' }),
        Matter.Bodies.rectangle(WORLD_WIDTH + T / 2, WORLD_HEIGHT / 2, T, WORLD_HEIGHT, { isStatic: true, label: 'wall' }),
    ]);
}

// --- WEBSOCKET KONEKCIJA ---

wss.on('connection', (ws) => {
    let myId = generateRandomId();
    ws.send(JSON.stringify({ type: 'welcome', myId: myId }));
    players[myId] = { team: 'spectator', keys: {}, name: 'Guest', roomId: null, facingX: 1, facingY: 0 };

    // Pošalji klijentu sve dimenzije terena - klijent ih više ne treba hardkodirane
    ws.send(JSON.stringify({
        type: 'world-info',
        WORLD_WIDTH: WORLD_WIDTH,
        WORLD_HEIGHT: WORLD_HEIGHT,
        ICE_WIDTH: ICE_WIDTH,
        ICE_HEIGHT: ICE_HEIGHT,
        GOAL_WIDTH: GOAL_WIDTH,
        GOAL_NET_DEPTH: GOAL_NET_DEPTH,
        T: T
    }));

    // Odmah pošalji trenutnu listu soba novom klijentu
    ws.send(JSON.stringify({ type: 'room-list', rooms: getRoomList() }));

    ws.on('close', () => {
        const p = players[myId];
        if (p) {
            // Ukloni fizičko telo iz sveta da ne ostane "duh" na terenu
            if (p.body && p.roomId && rooms[p.roomId]) {
                Matter.World.remove(rooms[p.roomId].engine.world, p.body);
            }

            // Ako je diskonektovani igrač bio admin, prebaci admina na sledećeg u sobi
            if (p.roomId && rooms[p.roomId] && rooms[p.roomId].adminId === myId) {
                const room = rooms[p.roomId];
                const nextAdmin = Object.keys(players).find(id => id !== myId && players[id].roomId === p.roomId);
                if (nextAdmin) {
                    room.adminId = nextAdmin;
                } else {
                    // Niko drugi nije ostao u sobi - obrisi sobu
                    delete rooms[p.roomId];
                }
            }
        }
        delete players[myId];
        broadcastRoomList();
    });

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        if (data.type === 'join-room') {
            const roomId = data.room;
            if (!rooms[roomId]) {
                // Soba ne postoji (npr. ugašena) - obavesti klijenta i osveži listu
                ws.send(JSON.stringify({ type: 'room-list', rooms: getRoomList() }));
                return;
            }
            ws.roomId = roomId;
            players[myId].roomId = roomId;
            players[myId].name = data.name || "Guest";
            // NAPOMENA: telo se namerno NE pravi ovde. Igrač ulazi kao spectator
            // (bez tela na terenu) - telo se kreira tek kad izabere red/blue tim.
            broadcastRoomList();

        } else if (data.type === 'create-room') {
            const newRoomId = generateRandomId();
            createRoom(newRoomId, myId);
            ws.send(JSON.stringify({ type: 'room-created', roomId: newRoomId }));
            broadcastRoomList();

        } else if (data.type === 'list-rooms') {
            ws.send(JSON.stringify({ type: 'room-list', rooms: getRoomList() }));

        } else if (data.type === 'chat') {
            broadcastToRoom(players[myId].roomId, { type: 'chat', senderId: myId, text: data.text });

        } else if (data.type === 'set-team') {
            const p = players[myId];
            const room = p.roomId ? rooms[p.roomId] : null;
            p.name = data.name;

            if (data.team === 'spectator') {
                // svako moze sam sebe da vrati u spectate
                setPlayerTeam(p, room, 'spectator');
            } else if (data.team === 'red' || data.team === 'blue') {
                // iz speca u red/blue moze samo host (i to samo sebe)
                if (room && room.adminId === myId) {
                    setPlayerTeam(p, room, data.team);
                }
                // obican igrac ne moze sam sebe da ubaci u tim - zahtev se ignorise
            }

        } else if (data.type === 'admin-set-team') {
            const p = players[myId];
            const room = p.roomId ? rooms[p.roomId] : null;
            const target = players[data.targetId];

            if (room && room.adminId === myId && target && target.roomId === p.roomId) {
                if (data.team === 'red' || data.team === 'blue' || data.team === 'spectator') {
                    setPlayerTeam(target, room, data.team);
                }
            }

        } else if (data.type === 'start-game') {
            let roomId = players[myId].roomId;
            let room = rooms[roomId];

            if (room && room.adminId === myId) {
                room.gameState = 'PLAYING';

                let noviLimit = parseInt(data.limit);
                room.goalLimit = (!isNaN(noviLimit) && noviLimit > 0) ? noviLimit : 5;

                resetRoom(roomId);

                console.log("Soba " + roomId + " kreće sa limitom: " + room.goalLimit);
                broadcastToRoom(roomId, { type: 'game-started' });
                broadcastRoomList();
            }

        } else if (data.type === 'shoot') {
            let p = players[myId];
            let room = rooms[p.roomId];
            if (p && p.body && room) {
                let dx = room.puck.position.x - p.body.position.x;
                let dy = room.puck.position.y - p.body.position.y;
                let distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < 50 && distance > 0) {
                    const SHOOT_SPEED = 16;
                    Matter.Body.setVelocity(room.puck, { x: (dx / distance) * SHOOT_SPEED, y: (dy / distance) * SHOOT_SPEED });
                    // Kratak period posle suta niko ne moze da "zalepi" loptu za sebe -
                    // daje lopti vremena da stvarno odleti umesto da se odmah vrati na igraca.
                    room.releaseUntil = Date.now() + 350;
                    room.ballCarrierId = null;
                }
            }

        } else if (data.type === 'key-down') {
            players[myId].keys[data.key] = true;

        } else if (data.type === 'key-up') {
            players[myId].keys[data.key] = false;
        }
    });
});

// --- GLAVNA PETLJA IGRE ---

const CONTROL_RADIUS = 34;   // na kojoj udaljenosti igrač "preuzima" loptu
const ATTACH_DISTANCE = 20;  // koliko ispred igrača lopta "lebdi" dok je vodi

setInterval(() => {
    for (let roomId in rooms) {
        let room = rooms[roomId];
        if (!room) continue;

        // 1. Kretanje igrača (i pamćenje smera gledanja - bitno za vođenje lopte)
        for (let id in players) {
            let p = players[id];
            if (p.roomId === roomId && p.body) {
                let dx = (p.keys['ArrowLeft'] || p.keys['KeyA']) ? -1 : ((p.keys['ArrowRight'] || p.keys['KeyD']) ? 1 : 0);
                let dy = (p.keys['ArrowUp'] || p.keys['KeyW']) ? -1 : ((p.keys['ArrowDown'] || p.keys['KeyS']) ? 1 : 0);
                if (dx !== 0 || dy !== 0) {
                    let magnitude = Math.sqrt(dx * dx + dy * dy);
                    let nx = dx / magnitude, ny = dy / magnitude;
                    p.facingX = nx; p.facingY = ny; // pamti poslednji smer kretanja i kad stane
                    if (Math.sqrt(p.body.velocity.x ** 2 + p.body.velocity.y ** 2) < 5) {
                        Matter.Body.applyForce(p.body, p.body.position, { x: nx * 0.03, y: ny * 0.03 });
                    }
                }
            }
        }

        // 2. Update fizike
        Matter.Engine.update(room.engine, 1000 / 60);

        // 3. Vođenje lopte (dribbling) - lopta se "lepi" ispred najbližeg igrača
        //    umesto da se samo gura fizikom. Ne radi tokom kratkog perioda posle suta.
        if (room.gameState === 'PLAYING' && !room.isResetting) {
            if (Date.now() >= room.releaseUntil) {
                let closestId = null, closestDist = Infinity;
                for (let id in players) {
                    let pl = players[id];
                    if (pl.roomId === roomId && pl.body) {
                        let dx = room.puck.position.x - pl.body.position.x;
                        let dy = room.puck.position.y - pl.body.position.y;
                        let dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist < CONTROL_RADIUS && dist < closestDist) {
                            closestDist = dist;
                            closestId = id;
                        }
                    }
                }
                room.ballCarrierId = closestId;

                if (closestId) {
                    let carrier = players[closestId];
                    // VAŽNO: koristi ?? a ne || - facingX/facingY mogu legitimno biti TAČNO 0
                    // (npr. čisto vertikalno kretanje ima facingX=0), a || bi to pogrešno
                    // tretiralo kao "nema vrednosti" i vratilo fallback (1), gurajući loptu
                    // dijagonalno umesto pravo ispred igrača.
                    let fx = carrier.facingX ?? 1, fy = carrier.facingY ?? 0;
                    let targetX = carrier.body.position.x + fx * ATTACH_DISTANCE;
                    let targetY = carrier.body.position.y + fy * ATTACH_DISTANCE;

                    // KLJUČNO: ograniči tačku lepljenja da ne probije liniju terena.
                    // Bez ovoga, driblanje ka liniji (naročito VERTIKALNO, jer je teren
                    // mnogo uži po visini nego po širini) gurne loptu "napred" preko
                    // linije pre nego što igrač stvarno stigne do nje - server to
                    // odmah proglašava autom i nasilno oduzme loptu od igrača.
                    targetX = Math.max(FIELD_LEFT + 5, Math.min(FIELD_RIGHT - 5, targetX));
                    targetY = Math.max(FIELD_TOP + 5, Math.min(FIELD_BOTTOM - 5, targetY));

                    Matter.Body.setPosition(room.puck, { x: targetX, y: targetY });
                    Matter.Body.setVelocity(room.puck, { x: carrier.body.velocity.x, y: carrier.body.velocity.y });
                    room.lastToucherTeam = carrier.team; // bitno za aut/korner/gol-aut pravila
                }
            } else {
                room.ballCarrierId = null;
            }
        }

        // 4. Pravila igre - GOL, ili lopta izašla iz igre (aut / korner / gol-aut)
        if (room.gameState === 'PLAYING' && !room.isResetting) {
            let p = room.puck.position;
            const inGoalY = p.y > startY + (ICE_HEIGHT / 2 - GOAL_WIDTH / 2) &&
                            p.y < startY + (ICE_HEIGHT / 2 + GOAL_WIDTH / 2);

            if (p.x <= FIELD_LEFT) {
                if (inGoalY) {
                    // GOL za plave (napadaju levu stranu)
                    room.score.teamBlue++;
                    handleGoalScored(roomId, room);
                } else if (room.lastToucherTeam === 'red') {
                    // Crveni (branioci) su je dodirnuli poslednji -> KORNER za plave
                    let cornerY = p.y < WORLD_HEIGHT / 2 ? FIELD_TOP + 10 : FIELD_BOTTOM - 10;
                    placeBall(room, FIELD_LEFT + 10, cornerY);
                    broadcastToRoom(roomId, { type: 'field-event', text: '🚩 Korner za plave!' });
                } else {
                    // Plavi (napadaci) su je dodirnuli poslednji -> GOL-AUT (izvode crveni)
                    placeBall(room, FIELD_LEFT + 130, WORLD_HEIGHT / 2);
                    broadcastToRoom(roomId, { type: 'field-event', text: '⚽ Gol-aut za crvene' });
                }

            } else if (p.x >= FIELD_RIGHT) {
                if (inGoalY) {
                    // GOL za crvene (napadaju desnu stranu)
                    room.score.teamRed++;
                    handleGoalScored(roomId, room);
                } else if (room.lastToucherTeam === 'blue') {
                    // Plavi (branioci) su je dodirnuli poslednji -> KORNER za crvene
                    let cornerY = p.y < WORLD_HEIGHT / 2 ? FIELD_TOP + 10 : FIELD_BOTTOM - 10;
                    placeBall(room, FIELD_RIGHT - 10, cornerY);
                    broadcastToRoom(roomId, { type: 'field-event', text: '🚩 Korner za crvene!' });
                } else {
                    // Crveni (napadaci) su je dodirnuli poslednji -> GOL-AUT (izvode plavi)
                    placeBall(room, FIELD_RIGHT - 130, WORLD_HEIGHT / 2);
                    broadcastToRoom(roomId, { type: 'field-event', text: '⚽ Gol-aut za plave' });
                }

            } else if (p.y <= FIELD_TOP || p.y >= FIELD_BOTTOM) {
                // AUT (lopta izašla preko bočne linije) - baca se sa mesta izlaska
                let throwY = p.y <= FIELD_TOP ? FIELD_TOP + 6 : FIELD_BOTTOM - 6;
                let throwX = Math.max(FIELD_LEFT + 6, Math.min(FIELD_RIGHT - 6, p.x));
                placeBall(room, throwX, throwY);
                broadcastToRoom(roomId, { type: 'field-event', text: '🥅 Aut!' });
            }
        }

        // 5. Slanje update-a klijentima
        // Šaljemo SVE igrače u sobi (uključujući spectatore, bez x/y) da bi lobby lista
        // i admin dugmići za premeštanje radili i pre starta igre.
        let playerList = {};
        for (let id in players) {
            const pl = players[id];
            if (pl.roomId === roomId) {
                playerList[id] = {
                    team: pl.team,
                    name: pl.name,
                    x: pl.body ? pl.body.position.x : null,
                    y: pl.body ? pl.body.position.y : null,
                    facingX: pl.facingX ?? 1,
                    facingY: pl.facingY ?? 0
                };
            }
        }
        broadcastToRoom(roomId, { type: 'update', puck: { x: room.puck.position.x, y: room.puck.position.y }, players: playerList, score: room.score, adminId: room.adminId });
    }
}, 1000 / 60);

function handleGoalScored(roomId, room) {
    let limit = room.goalLimit || 5;
    if (room.score.teamBlue >= limit || room.score.teamRed >= limit) {
        broadcastToRoom(roomId, { type: 'game-over', winner: room.score.teamBlue >= limit ? 'Blue' : 'Red' });
        room.gameState = 'LOBBY';
        room.score = { teamRed: 0, teamBlue: 0 };
        broadcastRoomList();
    }
    resetRoom(roomId);
}

server.listen(3000, () => console.log('Server radi!'));
