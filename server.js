// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game state - Initialize these BEFORE any functions that use them
const rooms = new Map();
const players = new Map();
const chatMessages = new Map(); // roomId -> array of messages

// Player colors
const playerColors = [
    "#FF3838", // Bright Red (better visibility than pure red)
    "#2D8CFF", // Vivid Blue 
    "#2ED573", // Lime Green (more distinct from yellow)
    "#FFD700", // Gold (easier on eyes than pure yellow)
    "#2C3E50", // Dark Blue-Black (softer than pure black)
    "#FF8C00"  // Dark Orange (more distinct from red)
];

// Room management
function createRoom(hostId, roomName, maxPlayers) {
    const roomId = uuidv4();
    const room = {
        id: roomId,
        name: roomName,
        host: hostId,
        players: [hostId],
        maxPlayers: parseInt(maxPlayers),
        gameState: null,
        status: 'waiting' // waiting, playing, finished
    };
    
    rooms.set(roomId, room);
    return room;
}

function joinRoom(playerId, roomId) {
    const room = rooms.get(roomId);
    if (room && room.players.length < room.maxPlayers && room.status === 'waiting') {
        // Check if player is already in the room
        if (room.players.includes(playerId)) {
            return null; // Player already in room
        }
        room.players.push(playerId);
        return room;
    }
    return null;
}

function leaveRoom(playerId, roomId) {
    const room = rooms.get(roomId);
    if (!room) {
        console.log(`Room ${roomId} not found when trying to leave`);
        return null;
    }
    
    console.log(`Removing player ${playerId} from room ${roomId}`);
    
    // Remove player from room
    room.players = room.players.filter(id => id !== playerId);
    
    // Handle host transfer if needed
    if (room.host === playerId && room.players.length > 0) {
        room.host = room.players[0]; // Transfer host to first player
        console.log(`Host transferred to ${room.host}`);
    }
    
    console.log(`Room ${roomId} now has ${room.players.length} players`);
    
    // Delete room if no players left
    if (room.players.length === 0) {
        console.log(`Deleting empty room: ${room.name} (${roomId})`);
        rooms.delete(roomId);
        chatMessages.delete(roomId); // Also clean up chat messages
        return null; // Room no longer exists
    }
    
    return room;
}

// Add Player Leaving Logic
function removePlayerFromGame(room, playerId) {
    if (!room || !room.gameState) {
        console.log('ERROR: No room or game state found');
        return;
    }
    
    const gameState = room.gameState;
    
    // Find player by ID instead of room index
    const playerIndex = gameState.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) {
        console.log(`ERROR: Player ${playerId} not found in gameState`);
        return;
    }
    
    const player = gameState.players[playerIndex];
    
    // Mark ONLY the leaving player as inactive
    player.active = false;
    console.log(`Marked player ${playerIndex} (${player.name}) as inactive`);
    
    // Store territories BEFORE clearing
    const territoriesToDistribute = [...player.territories];
    
    // Clear the leaving player's territories
    player.territories = [];
    
    // If it's the leaving player's turn, skip to next active player
    if (gameState.currentPlayer === playerIndex) {
        console.log(`Player ${playerIndex} was current player, skipping to next active player`);
        const nextPlayer = skipToNextActivePlayer(gameState, room);
        
        if (nextPlayer !== playerIndex) {
            gameState.phase = 'reinforce';
            const newCurrentPlayer = gameState.players[nextPlayer];
            
            if (newCurrentPlayer && newCurrentPlayer.active) {
                // Calculate reinforcements
                newCurrentPlayer.reinforcements = Math.max(3, Math.floor(newCurrentPlayer.territories.length / 3));
                
                // Add region bonuses
                Object.entries(gameState.regions).forEach(([region, territories]) => {
                    const ownsRegion = territories.every(territoryId => 
                        newCurrentPlayer.territories.includes(territoryId)
                    );
                    
                    if (ownsRegion) {
                        newCurrentPlayer.reinforcements += gameState.regionBonuses[region];
                    }
                });
                
                console.log(`New current player: ${nextPlayer} (${newCurrentPlayer.name}) with ${newCurrentPlayer.reinforcements} reinforcements`);
            }
        }
    }
    
    // Distribute territories to ACTIVE players only
    const activePlayers = gameState.players.filter(p => p.active);
    
    if (activePlayers.length > 0 && territoriesToDistribute.length > 0) {
        
        territoriesToDistribute.forEach(territoryId => {
            const territory = gameState.territories.find(t => t.id === territoryId);
            if (territory) {
                const newOwnerIndex = Math.floor(Math.random() * activePlayers.length);
                const newOwner = activePlayers[newOwnerIndex];
                const newOwnerGlobalIndex = gameState.players.indexOf(newOwner);
                
                territory.owner = newOwnerGlobalIndex;
                territory.troops = 1;
                newOwner.territories.push(territoryId);
            }
        });
    }
    
    // **CRITICAL: Broadcast the updated game state to all clients**
    io.to(room.id).emit('game-state-update', gameState);
}

function skipToNextActivePlayer(gameState, room) {
    const originalPlayer = gameState.currentPlayer;
    let nextPlayer = (gameState.currentPlayer + 1) % gameState.players.length;
    let attempts = 0;
    
    console.log(`Looking for next active player. Starting from ${originalPlayer}`);
    console.log('Player status:', gameState.players.map((p, idx) => `${idx}: ${p.name} (active: ${p.active})`).join(', '));
    
    // Find next active player
    while (!gameState.players[nextPlayer].active && attempts < gameState.players.length) {
        console.log(`Player ${nextPlayer} (${gameState.players[nextPlayer].name}) is inactive, skipping`);
        nextPlayer = (nextPlayer + 1) % gameState.players.length;
        attempts++;
    }
    
    // If we found an active player, set them as current
    if (gameState.players[nextPlayer].active) {
        gameState.currentPlayer = nextPlayer;
        
        console.log(`Turn skipped from player ${originalPlayer} to active player ${nextPlayer} (${gameState.players[nextPlayer].name})`);
        return nextPlayer;
    } else {
        // No active players found
        console.log('No active players found when skipping turn');
        return originalPlayer;
    }
}

// Add function to check if game should end when players leave
function checkGameEndCondition(room) {
    if (!room || !room.gameState) return;
    
    const gameState = room.gameState;
    const activePlayers = gameState.players.filter(player => player.active);
    
    // If only one active player remains, they win
    if (activePlayers.length === 1) {
        room.status = 'finished';
        const winner = activePlayers[0];
        const winnerIndex = gameState.players.indexOf(winner);
        
        io.to(room.id).emit('game-finished', {
            winner: winnerIndex,
            winnerName: winner.name,
            reason: 'All other players left the game'
        });
        
        // Add victory message to chat
        const victoryMessage = {
            id: uuidv4(),
            playerId: 'system',
            playerName: 'System',
            message: `${winner.name} wins! All other players left the game.`,
            timestamp: new Date().toISOString()
        };
        
        const messages = chatMessages.get(room.id) || [];
        messages.push(victoryMessage);
        io.to(room.id).emit('chat-message', victoryMessage);
    }
    // If no active players remain, end game with no winner
    else if (activePlayers.length === 0) {
        room.status = 'finished';
        io.to(room.id).emit('game-finished', {
            winner: -1,
            winnerName: 'No one',
            reason: 'All players left the game'
        });
        
        const gameOverMessage = {
            id: uuidv4(),
            playerId: 'system',
            playerName: 'System',
            message: 'Game over! All players left the game.',
            timestamp: new Date().toISOString()
        };
        
        const messages = chatMessages.get(room.id) || [];
        messages.push(gameOverMessage);
        io.to(room.id).emit('chat-message', gameOverMessage);
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Store player info with default name
    players.set(socket.id, {
        id: socket.id,
        name: `Player${Math.floor(Math.random() * 1000)}`,
        roomId: null
    });
    
    // Send available rooms to the new player
    socket.emit('rooms-list', getAvailableRooms());
    socket.emit('player-id', socket.id);
    
    // Handle room list requests
    socket.on('get-rooms', () => {
        socket.emit('rooms-list', getAvailableRooms());
    });
    
    // Handle player name setting
    socket.on('set-player-name', (name) => {
        const player = players.get(socket.id);
        if (player && name && name.trim() !== '') {
            player.name = name.trim();
            
            // Notify all clients about room updates when name changes
            io.emit('rooms-list', getAvailableRooms());
            
            // Notify room if player is in one
            if (player.roomId) {
                io.to(player.roomId).emit('room-updated', getRoomData(player.roomId));
            }
        }
    });
    
    // Handle room creation
    socket.on('create-room', (data) => {
        const { roomName, maxPlayers } = data;
        const player = players.get(socket.id);
        
        if (player) {
            // Leave current room if any
            if (player.roomId) {
                leaveRoom(socket.id, player.roomId);
            }
            
            const room = createRoom(socket.id, roomName, maxPlayers);
            player.roomId = room.id;
            
            // Initialize chat for this room with a welcome message
            chatMessages.set(room.id, []);
            
            // Add system welcome message
            const welcomeMessage = {
                id: uuidv4(),
                playerId: 'system',
                playerName: 'System',
                message: `Room "${roomName}" created! Welcome to the game chat!`,
                timestamp: new Date().toISOString()
            };
            
            const messages = chatMessages.get(room.id);
            messages.push(welcomeMessage);
            
            socket.join(room.id);
            socket.emit('room-created', getRoomData(room.id));
            
            // Send chat history to the host
            socket.emit('chat-history', messages);
            
            // Notify ALL players about room update
            io.emit('rooms-list', getAvailableRooms());
            io.to(room.id).emit('room-updated', getRoomData(room.id));
            
            console.log(`Room created: ${room.name} by ${player.name}`);
        }
    });
    
    // Handle room joining
    socket.on('join-room', (roomId) => {
        const player = players.get(socket.id);
        const room = rooms.get(roomId);
        
        if (!room) {
            socket.emit('join-error', 'Room not found');
            return;
        }
        
        if (room.status !== 'waiting') {
            socket.emit('join-error', 'Game already in progress');
            return;
        }
        
        if (room.players.length >= room.maxPlayers) {
            socket.emit('join-error', 'Room is full');
            return;
        }
        
        // NEW: Check if player is already in this room
        if (room.players.includes(socket.id)) {
            socket.emit('join-error', 'You are already in this room');
            return;
        }
        
        if (player && room) {
            // Leave current room if any (this handles the case where player is in a different room)
            if (player.roomId && player.roomId !== roomId) {
                leaveRoom(socket.id, player.roomId);
            }
            
            // If player is already in this room, just send current room data
            if (player.roomId === roomId) {
                socket.emit('room-joined', getRoomData(roomId));
                return;
            }
            
            const joinedRoom = joinRoom(socket.id, roomId);
            if (joinedRoom) {
                player.roomId = roomId;
                socket.join(roomId);
                
                socket.emit('room-joined', getRoomData(roomId));
                
                // Notify ALL players about room update
                io.emit('rooms-list', getAvailableRooms());
                io.to(roomId).emit('room-updated', getRoomData(roomId));
                
                // Add join notification to chat
                const joinMessage = {
                    id: uuidv4(),
                    playerId: 'system',
                    playerName: 'System',
                    message: `${player.name} joined the room!`,
                    timestamp: new Date().toISOString()
                };
                
                const messages = chatMessages.get(roomId) || [];
                messages.push(joinMessage);
                
                // Send full chat history to the joining player
                socket.emit('chat-history', messages);
                
                // Broadcast the join message to all players in the room
                io.to(roomId).emit('chat-message', joinMessage);
                
            } else {
                socket.emit('join-error', 'Could not join room');
            }
        }
    });
    
    // Handle leaving room
    socket.on('leave-room', () => {
        const player = players.get(socket.id);
        
        if (player && player.roomId) {
            const roomId = player.roomId;
            const room = leaveRoom(socket.id, roomId);
            
            // Add leave notification to chat only if room still exists
            if (room) {
                const leaveMessage = {
                    id: uuidv4(),
                    playerId: 'system',
                    playerName: 'System',
                    message: `${player.name} left the room.`,
                    timestamp: new Date().toISOString()
                };
                
                const messages = chatMessages.get(roomId) || [];
                messages.push(leaveMessage);
                
                // Broadcast leave message to remaining players
                io.to(roomId).emit('chat-message', leaveMessage);
            }
            
            socket.leave(roomId);
            player.roomId = null;
            
            socket.emit('room-left');
            io.emit('rooms-list', getAvailableRooms());
            
            if (room) {
                io.to(roomId).emit('room-updated', getRoomData(roomId));
            }
            
            console.log(`Player ${player.name} left room`);
        }
    });
    
    // Add a dedicated leave-game handler for in-game leaving
    socket.on('leave-game', () => {
        const player = players.get(socket.id);
        
        if (player && player.roomId) {
            const roomId = player.roomId;
            const room = rooms.get(roomId);
            
            if (room && room.status === 'playing') {
                // Add leave notification to chat
                const leaveMessage = {
                    id: uuidv4(),
                    playerId: 'system',
                    playerName: 'System',
                    message: `${player.name} has left the game.`,
                    timestamp: new Date().toISOString()
                };
                
                const messages = chatMessages.get(roomId) || [];
                messages.push(leaveMessage);
                
                // Handle player removal from game
                removePlayerFromGame(room, socket.id);
                
                // Broadcast leave message and game state update
                io.to(roomId).emit('chat-message', leaveMessage);
                io.to(roomId).emit('game-state-update', room.gameState);
                io.to(roomId).emit('player-left-game', {
                    playerId: socket.id,
                    playerName: player.name
                });
                
                // Check if game should end (only one player left)
                checkGameEndCondition(room);
            }
            
            // Now handle the room leaving
            const updatedRoom = leaveRoom(socket.id, roomId);
            
            socket.leave(roomId);
            player.roomId = null;
            
            socket.emit('game-left');
            io.emit('rooms-list', getAvailableRooms());
            
            if (updatedRoom) {
                io.to(roomId).emit('room-updated', getRoomData(roomId));
            }
            
            console.log(`Player ${player.name} left game in room ${roomId}`);
        }
    });
    
    // Handle starting game
    socket.on('start-game', () => {
        const player = players.get(socket.id);
        
        if (player && player.roomId) {
            const room = rooms.get(player.roomId);
            
            // Only host can start the game
            if (room && room.host === socket.id && room.status === 'waiting') {
                room.status = 'playing';
                room.gameState = initializeGameState(room);
                
                // Add game start message to chat
                const startMessage = {
                    id: uuidv4(),
                    playerId: 'system',
                    playerName: 'System',
                    message: 'Game started! Good luck everyone!',
                    timestamp: new Date().toISOString()
                };
                
                const messages = chatMessages.get(room.id) || [];
                messages.push(startMessage);
                
                io.to(room.id).emit('game-started', room.gameState);
                io.to(room.id).emit('chat-message', startMessage);
            }
        }
    });
    
    // Handle game actions
    socket.on('game-action', (data) => {
        const player = players.get(socket.id);
        
        if (player && player.roomId) {
            const room = rooms.get(player.roomId);
            
            if (room && room.status === 'playing') {
                const playerIndex = getPlayerIndex(room, socket.id);
                
                // **FIX: Get current player ID from gameState, not room.players**
                const currentPlayerObj = room.gameState.players[room.gameState.currentPlayer];
                const currentPlayerId = currentPlayerObj ? currentPlayerObj.id : null;

                // Validate player index
                if (playerIndex === -1) {
                    console.log('BLOCKED: Player index not found');
                    socket.emit('action-error', 'Player not found in game');
                    return;
                }
                
                // Validate player is active
                if (!room.gameState.players[playerIndex].active) {
                    console.log('BLOCKED: Player is inactive');
                    socket.emit('action-error', 'You are no longer in the game');
                    return;
                }
                
                // **FIX: Compare with current player ID from gameState**
                if (currentPlayerId !== socket.id) {
                    console.log(`BLOCKED: Not player's turn. Current player ID: ${currentPlayerId}, Acting player ID: ${socket.id}`);
                    socket.emit('action-error', "It's not your turn!");
                    return;
                }
                
                processGameAction(room, data, playerIndex);
                io.to(room.id).emit('game-state-update', room.gameState);
                
                // Check win condition
                const winner = checkWinCondition(room.gameState);
                if (winner !== -1) {
                    room.status = 'finished';
                    io.to(room.id).emit('game-finished', {
                        winner: winner,
                        winnerName: room.gameState.players[winner].name
                    });
                }
            }
        }
    });
    
    // Handle chat messages
    socket.on('chat-message', (data) => {
        const player = players.get(socket.id);
        
        if (player && player.roomId && data.message && data.message.trim() !== '') {
            const roomId = player.roomId;
            const message = {
                id: uuidv4(),
                playerId: socket.id,
                playerName: player.name,
                message: data.message.trim(),
                timestamp: new Date().toISOString()
            };
            
            // Add message to room's chat history
            if (!chatMessages.has(roomId)) {
                chatMessages.set(roomId, []);
            }
            
            const messages = chatMessages.get(roomId);
            messages.push(message);
            
            // Keep only last 100 messages
            if (messages.length > 100) {
                messages.shift();
            }
            
            // Broadcast to all players in the room
            io.to(roomId).emit('chat-message', message);
        }
    });
    
    // Handle player name change
    socket.on('change-name', (name) => {
        const player = players.get(socket.id);
        if (player) {
            player.name = name;
            
            if (player.roomId) {
                io.to(player.roomId).emit('room-updated', getRoomData(player.roomId));
            }
        }
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        const player = players.get(socket.id);
        if (player && player.roomId) {
            const roomId = player.roomId;
            const room = rooms.get(roomId);
            
            if (room && room.status === 'playing') {
                // Use the same logic as leave-game for disconnections during gameplay
                removePlayerFromGame(room, socket.id);
                
                // Notify other players
                io.to(roomId).emit('player-left-game', {
                    playerId: socket.id,
                    playerName: player.name
                });
                
                io.to(roomId).emit('game-state-update', room.gameState);
                
                // Check if game should end
                checkGameEndCondition(room);
            }
            
            // Handle room leaving
            const updatedRoom = leaveRoom(socket.id, roomId);
            
            io.emit('rooms-list', getAvailableRooms());
            
            if (updatedRoom) {
                io.to(roomId).emit('room-updated', getRoomData(roomId));
                
                // Add disconnect message to chat
                const disconnectMessage = {
                    id: uuidv4(),
                    playerId: 'system',
                    playerName: 'System',
                    message: `${player.name} disconnected.`,
                    timestamp: new Date().toISOString()
                };
                
                const messages = chatMessages.get(roomId) || [];
                messages.push(disconnectMessage);
                io.to(roomId).emit('chat-message', disconnectMessage);
            }
        }
        
        players.delete(socket.id);
    });

});

// Helper functions
function getAvailableRooms() {
    const availableRooms = Array.from(rooms.values())
        .filter(room => room.status === 'waiting' && room.players.length < room.maxPlayers)
        .map(room => ({
            id: room.id,
            name: room.name,
            players: room.players.length,
            maxPlayers: room.maxPlayers,
            host: players.get(room.host)?.name || 'Unknown'
        }));
    
    return availableRooms;
}

function getRoomData(roomId) {
    const room = rooms.get(roomId);
    if (!room) return null;
    
    return {
        id: room.id,
        name: room.name,
        host: room.host,
        players: room.players.map(playerId => ({
            id: playerId,
            name: players.get(playerId)?.name || 'Unknown'
        })),
        maxPlayers: room.maxPlayers,
        status: room.status
    };
}

// And update getPlayerIndex to be simpler:
function getPlayerIndex(room, playerId) {
    if (!room || !room.gameState) return -1;
    
    // **FIX: Find index in gameState players by ID**
    const index = room.gameState.players.findIndex(p => p.id === playerId);
    return index;
}

function initializeGameState(room) {
    const playerCount = room.players.length;
    const gamePlayers = room.players.map((playerId, index) => ({
        id: playerId,
        name: players.get(playerId)?.name || `Player ${index + 1}`,
        color: playerColors[index],
        territories: [],
        reinforcements: 0,
        battleRewards: 0,
        active: true
    }));
    
    // Territory data
    const territoryData = [
        { id: 1, name: "Alaska", x: 90, y: 80, connections: [2, 3, 6] },
        { id: 2, name: "Northwest Territory", x: 160, y: 80, connections: [1, 3, 4, 5] },
        { id: 3, name: "Alberta", x: 160, y: 120, connections: [1, 2, 4, 6] },
        { id: 4, name: "Ontario", x: 200, y: 110, connections: [2, 3, 5, 7] },
        { id: 5, name: "Quebec", x: 250, y: 110, connections: [2, 4, 7, 8, 38] },
        { id: 6, name: "Western United States", x: 130, y: 150, connections: [1, 3, 7, 9] },
        { id: 7, name: "Eastern United States", x: 210, y: 150, connections: [4, 5, 6, 8, 9] },
        { id: 8, name: "Central America", x: 200, y: 210, connections: [5, 7, 9, 10] },
        { id: 9, name: "Mexico", x: 160, y: 180, connections: [6, 7, 8] },
        { id: 10, name: "Venezuela", x: 240, y: 250, connections: [8, 11, 12] },
        { id: 11, name: "Peru", x: 260, y: 300, connections: [10, 12, 13] },
        { id: 12, name: "Brazil", x: 330, y: 280, connections: [10, 11, 13, 14] },
        { id: 13, name: "Argentina", x: 260, y: 370, connections: [11, 12] },
        { id: 14, name: "North Africa", x: 450, y: 190, connections: [12, 15, 16, 17, 40] },
        { id: 15, name: "Egypt", x: 520, y: 190, connections: [14, 16, 20, 41] },
        { id: 16, name: "East Africa", x: 550, y: 240, connections: [14, 15, 17, 19, 20] },
        { id: 17, name: "Congo", x: 500, y: 270, connections: [14, 16, 18] },
        { id: 18, name: "South Africa", x: 500, y: 330, connections: [17, 19] },
        { id: 19, name: "Madagascar", x: 570, y: 310, connections: [16, 18, 20] },
        { id: 20, name: "Middle East", x: 580, y: 190, connections: [15, 16, 19, 21, 22] },
        { id: 21, name: "Afghanistan", x: 550, y: 140, connections: [20, 22, 23, 24, 28, 42] },
        { id: 22, name: "India", x: 670, y: 190, connections: [20, 21, 23, 26] },
        { id: 23, name: "China", x: 750, y: 160, connections: [21, 22, 26, 28, 30, 31] },
        { id: 24, name: "Ural", x: 580, y: 80, connections: [21, 25, 36, 42] },
        { id: 25, name: "Siberia", x: 620, y: 70, connections: [24, 27, 28] },
        { id: 26, name: "Thailand", x: 740, y: 210, connections: [22, 23, 32] },
        { id: 27, name: "Yakutsk", x: 710, y: 60, connections: [25, 28, 29] },
        { id: 28, name: "Irkutsk", x: 710, y: 120, connections: [21, 23, 25, 27, 29, 30] },
        { id: 29, name: "Kamchatka", x: 850, y: 70, connections: [27, 28, 30, 31] },
        { id: 30, name: "Mongolia", x: 780, y: 120, connections: [23, 28, 29, 31] },
        { id: 31, name: "Japan", x: 840, y: 140, connections: [23, 29, 30, 32] },
        { id: 32, name: "Indonesia", x: 790, y: 240, connections: [26, 31, 33, 34] },
        { id: 33, name: "New Guinea", x: 810, y: 300, connections: [32, 34, 35] },
        { id: 34, name: "Western Australia", x: 780, y: 330, connections: [32, 33, 35] },
        { id: 35, name: "Eastern Australia", x: 860, y: 330, connections: [33, 34] },
        { id: 36, name: "Scandinavia", x: 500, y: 70, connections: [24, 37, 38, 39, 42] },
        { id: 37, name: "Iceland", x: 400, y: 60, connections: [36, 38] },
        { id: 38, name: "Great Britain", x: 430, y: 90, connections: [5, 36, 37, 39, 40] },
        { id: 39, name: "Northern Europe", x: 470, y: 100, connections: [36, 38, 40, 41] },
        { id: 40, name: "Western Europe", x: 430, y: 140, connections: [14, 38, 39, 41] },
        { id: 41, name: "Southern Europe", x: 480, y: 140, connections: [15, 39, 40, 42] },
        { id: 42, name: "Ukraine", x: 520, y: 110, connections: [21, 24, 36, 41] }
    ];
    
    const territories = [];
    const territoriesPerPlayer = Math.floor(territoryData.length / playerCount);
    
    // Distribute territories evenly
    for (let i = 0; i < territoryData.length; i++) {
        const owner = i % playerCount;
        const troops = 1 + Math.floor(Math.random() * 3);
        
        territories.push({
            ...territoryData[i],
            owner: owner,
            troops: troops
        });
        
        gamePlayers[owner].territories.push(territoryData[i].id);
    }
    
    // Calculate initial reinforcements
    gamePlayers.forEach(player => {
        player.reinforcements = Math.max(3, Math.floor(player.territories.length / 3));
    });
    
    return {
        players: gamePlayers,
        currentPlayer: 0,
        phase: 'reinforce',
        territories: territories,
        regions: {
            "North America": [1, 2, 3, 4, 5, 6, 7, 8, 9],
            "South America": [10, 11, 12, 13],
            "Europe": [36, 37, 38, 39, 40, 41, 42],
            "Africa": [14, 15, 16, 17, 18, 19],
            "Asia": [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
            "Australia": [32, 33, 34, 35]
        },
        regionBonuses: {
            "North America": 5,
            "South America": 2,
            "Europe": 5,
            "Africa": 3,
            "Asia": 7,
            "Australia": 2
        }
    };
}

function processGameAction(room, data, playerIndex) {
    const gameState = room.gameState;
    
    // Skip if player is inactive
    if (!gameState.players[playerIndex].active) {
        console.log(`Inactive player ${playerIndex} tried to take action, skipping`);
        return;
    }
    
    switch (data.type) {
        case 'reinforce':
            if (gameState.phase === 'reinforce') {
                const territory = gameState.territories.find(t => t.id === data.territoryId);
                const player = gameState.players[playerIndex];
                
                if (territory && territory.owner === playerIndex && player.reinforcements > 0) {
                    territory.troops += 1;
                    player.reinforcements -= 1;
                }
            }
            break;
        case 'use-battle-rewards':
            if (gameState.phase === 'reinforce') {
                const player = gameState.players[playerIndex];
                if (player.battleRewards && player.battleRewards > 0) {
                    player.reinforcements += player.battleRewards;
                    
                    // Add notification
                    const rewardMessage = {
                        id: uuidv4(),
                        playerId: 'system',
                        playerName: 'System',
                        message: `${player.name} used ${player.battleRewards} battle reward(s) for reinforcements!`,
                        timestamp: new Date().toISOString()
                    };
                    
                    const messages = chatMessages.get(room.id) || [];
                    messages.push(rewardMessage);
                    io.to(room.id).emit('chat-message', rewardMessage);
                    
                    player.battleRewards = 0;
                }
            }
            break;  
        case 'attack':
            if (gameState.phase === 'attack' && data.source && data.target) {
                const source = gameState.territories.find(t => t.id === data.source);
                const target = gameState.territories.find(t => t.id === data.target);
                
                if (source && target && source.owner === playerIndex && 
                    target.owner !== playerIndex && source.connections.includes(target.id)) {
                    
                    // Calculate battle rewards
                    const attackerReward = calculateBattleReward();
                    const defenderReward = calculateBattleReward();
                    
                    // Resolve combat using improved dice-based system
                    const combatResult = resolveCombat(data.troops, target.troops);
                    
                    if (combatResult.attackerWins) {
                        // Attacker wins the battle
                        const previousOwner = target.owner;
                        const defenderPlayer = gameState.players[previousOwner];
                        target.owner = playerIndex;
                        
                        // Update troop counts
                        source.troops -= data.troops; // Remove original attacking troops from source
                        target.troops = combatResult.attackerRemaining; // Surviving troops move into conquered territory
                        
                        // Update territory lists
                        const prevPlayer = gameState.players[previousOwner];
                        const newPlayer = gameState.players[playerIndex];
                        
                        prevPlayer.territories = prevPlayer.territories.filter(id => id !== target.id);
                        newPlayer.territories.push(target.id);
                        
                        // Award battle reward to the attacker
                        newPlayer.battleRewards = (newPlayer.battleRewards || 0) + attackerReward;
                        
                        // Add battle reward notification
                        const rewardMessage = {
                            id: uuidv4(),
                            playerId: 'system',
                            playerName: 'System',
                            message: `${newPlayer.name} earned a battle reward of ${attackerReward} reinforcement(s) for conquering ${target.name}!`,
                            timestamp: new Date().toISOString()
                        };
                        
                        const messages = chatMessages.get(room.id) || [];
                        messages.push(rewardMessage);
                        io.to(room.id).emit('chat-message', rewardMessage);
                        
                        // Check if previous player has been eliminated
                        if (prevPlayer.territories.length === 0) {
                            prevPlayer.active = false;
                            
                            const eliminationMessage = {
                                id: uuidv4(),
                                playerId: 'system',
                                playerName: 'System',
                                message: `${prevPlayer.name} has been eliminated from the game!`,
                                timestamp: new Date().toISOString()
                            };
                            
                            messages.push(eliminationMessage);
                            io.to(room.id).emit('chat-message', eliminationMessage);
                        }
                    } else {
                        // Defender wins the battle
                        source.troops -= data.troops; // Attacker loses all attacking troops
                        target.troops = combatResult.defenderRemaining; // Defender keeps surviving troops
                        
                        // Award battle reward to the defender
                        const defenderPlayer = gameState.players[target.owner];
                        defenderPlayer.battleRewards = (defenderPlayer.battleRewards || 0) + defenderReward;
                        
                        // Add defender reward notification
                        const defenseMessage = {
                            id: uuidv4(),
                            playerId: 'system',
                            playerName: 'System',
                            message: `${defenderPlayer.name} earned a battle reward of ${defenderReward} reinforcement(s) for successfully defending ${target.name}!`,
                            timestamp: new Date().toISOString()
                        };
                        
                        const messages = chatMessages.get(room.id) || [];
                        messages.push(defenseMessage);
                        io.to(room.id).emit('chat-message', defenseMessage);
                    }
                    
                    // Add detailed combat result to chat
                    const combatMessage = {
                        id: uuidv4(),
                        playerId: 'system',
                        playerName: 'System',
                        message: `BATTLE: ${gameState.players[playerIndex].name} attacked ${target.name} from ${source.name}. ${combatResult.attackerWins ? 'Attacker won!' : 'Defender held!'} (Attacker: ${combatResult.attackerRemaining} survived, Defender: ${combatResult.defenderRemaining} survived)`,
                        timestamp: new Date().toISOString()
                    };
                    
                    const allMessages = chatMessages.get(room.id) || [];
                    allMessages.push(combatMessage);
                    io.to(room.id).emit('chat-message', combatMessage);
                }
            }
            break;
            
        case 'fortify':
            if (gameState.phase === 'fortify' && data.source && data.target) {
                const source = gameState.territories.find(t => t.id === data.source);
                const target = gameState.territories.find(t => t.id === data.target);
                
                if (source && target && source.owner === playerIndex && 
                    target.owner === playerIndex && areTerritoriesConnected(gameState, source.id, target.id, playerIndex)) {
                    
                    if (source.troops > data.troops) {
                        source.troops -= data.troops;
                        target.troops += data.troops;
                    }
                }
            }
            break;
            
        case 'end-phase':
            if (data.phase === 'reinforce') {
                gameState.phase = 'attack';
            } else if (data.phase === 'attack') {
                gameState.phase = 'fortify';
            } else if (data.phase === 'fortify') {
                // Skip to next active player
                skipToNextActivePlayer(gameState);
                gameState.phase = 'reinforce';
                
                // Calculate reinforcements for new player
                const player = gameState.players[gameState.currentPlayer];
                if (player.active) {
                    player.reinforcements = Math.max(3, Math.floor(player.territories.length / 3));
                    
                    // Add region bonuses
                    Object.entries(gameState.regions).forEach(([region, territories]) => {
                        const ownsRegion = territories.every(territoryId => 
                            player.territories.includes(territoryId)
                        );
                        
                        if (ownsRegion) {
                            player.reinforcements += gameState.regionBonuses[region];
                        }
                    });
                } else {
                    // If somehow we ended up on an inactive player, skip again
                    console.log('Ended turn on inactive player, skipping again');
                    skipToNextActivePlayer(gameState);
                }
            }
            break;
    }
}

function areTerritoriesConnected(gameState, fromId, toId, playerId, visited = []) {
    if (fromId === toId) return true;
    
    const fromTerritory = gameState.territories.find(t => t.id === fromId);
    if (!fromTerritory || fromTerritory.owner !== playerId) return false;
    
    visited.push(fromId);
    
    for (const connId of fromTerritory.connections) {
        if (!visited.includes(connId) && areTerritoriesConnected(gameState, connId, toId, playerId, visited)) {
            return true;
        }
    }
    
    return false;
}

function checkWinCondition(gameState) {
    const activePlayers = gameState.players.filter(player => player.active);
    
    // If only one active player remains, they win
    if (activePlayers.length === 1) {
        return gameState.players.indexOf(activePlayers[0]);
    }
    
    // Check if any active player owns all territories
    for (let i = 0; i < gameState.players.length; i++) {
        if (gameState.players[i].active && gameState.players[i].territories.length === gameState.territories.length) {
            return i;
        }
    }
    
    return -1;
}

// Add dice rolling and combat logic to server
function rollDice(numberOfDice) {
    const rolls = [];
    for (let i = 0; i < numberOfDice; i++) {
        rolls.push(Math.floor(Math.random() * 6) + 1);
    }
    return rolls.sort((a, b) => b - a);
}

// Combat logic
function resolveCombat(attackerTroops, defenderTroops) {

    // Battle continues until one side is eliminated
    while (attackerTroops > 0 && defenderTroops > 0) {
        // Determine number of dice for each side
        const attackerDice = Math.min(3, attackerTroops); // Max 3 dice
        const defenderDice = Math.min(2, defenderTroops); // Max 2 dice
        
        // Roll dice
        const attackerRolls = rollDice(attackerDice);
        const defenderRolls = rollDice(defenderDice);
        
        // Compare dice (number of comparisons = min number of dice)
        const comparisons = Math.min(attackerRolls.length, defenderRolls.length);
        let attackerLosses = 0;
        let defenderLosses = 0;
        
        for (let i = 0; i < comparisons; i++) {
            if (attackerRolls[i] > defenderRolls[i]) {
                defenderLosses++;
            } else {
                // Defender wins on ties
                attackerLosses++;
            }
        }
        
        // Apply losses
        attackerTroops -= attackerLosses;
        defenderTroops -= defenderLosses;
        
        // Stop if battle is over
        if (defenderTroops <= 0 || attackerTroops <= 0) {
            break;
        }
    }
    
    return {
        attackerRemaining: attackerTroops,
        defenderRemaining: defenderTroops,
        attackerWins: defenderTroops <= 0
    };
}

// Calculate battle rewards
function calculateBattleReward() {
    const random = Math.random() * 100;
    
    if (random < 35) return 1;      // 35% probability
    else if (random < 60) return 2; // 25% probability
    else if (random < 80) return 3; // 20% probability
    else if (random < 95) return 5; // 15% probability
    else return 10;                 // 5% probability
}

const PORT = 3003;
server.listen(PORT, () => {
    console.log(`World Domination server running on port ${PORT}`);
});