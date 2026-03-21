// Connection and authentication management

const fs = require('fs');
const path = require('path');

class ConnectionManager {
  constructor(options = {}) {
    this.connections = new Map(); // ws -> connectionInfo
    this.names = new Set();
    this.authTimeout = 5000;
    this.protectedMode = options.protectedMode || false;

    // Load passwords
    const passwordsPath = path.join(__dirname, 'passwords.json');
    try {
      this.passwords = JSON.parse(fs.readFileSync(passwordsPath, 'utf8'));
    } catch (err) {
      console.error('Failed to load passwords.json:', err.message);
      this.passwords = { '0': 'player', '1': 'player', spectator: 'spectator' };
    }
  }

  addConnection(ws) {
    const connectionInfo = {
      ws,
      authenticated: false,
      teamId: null,
      isSpectator: false,
      isOversight: false,
      name: null,
      authTimer: null,
    };

    this.connections.set(ws, connectionInfo);

    connectionInfo.authTimer = setTimeout(() => {
      if (!connectionInfo.authenticated) {
        this.send(ws, { type: 'AUTH_FAILED', reason: 'Authentication timeout' });
        ws.close();
      }
    }, this.authTimeout);

    return connectionInfo;
  }

  removeConnection(ws) {
    const info = this.connections.get(ws);
    if (info) {
      if (info.authTimer) clearTimeout(info.authTimer);
      if (info.name) this.names.delete(info.name);
      this.connections.delete(ws);
    }
  }

  generateUniqueName(baseName) {
    if (!this.names.has(baseName)) {
      this.names.add(baseName);
      return baseName;
    }

    let counter = 1;
    let uniqueName = `${baseName}(${counter})`;
    while (this.names.has(uniqueName)) {
      counter++;
      uniqueName = `${baseName}(${counter})`;
    }
    this.names.add(uniqueName);
    return uniqueName;
  }

  authenticate(ws, message) {
    const info = this.connections.get(ws);
    if (!info) return { success: false, reason: 'Connection not found' };
    if (info.authenticated) return { success: false, reason: 'Already authenticated' };

    const { password, name, preferredTeam } = message;

    let teamId = null;
    let isSpectator = false;
    let isOversight = false;

    // Check oversight password first (works in both modes)
    const oversightPass = this.passwords.oversight;
    if (oversightPass && password === oversightPass) {
      teamId = -1;
      isSpectator = true;
      isOversight = true;
    } else if (this.protectedMode) {
      // Protected mode: password determines the team
      // Look up which team this password belongs to
      let matched = false;

      // Check spectator first
      if (password === this.passwords.spectator) {
        teamId = -1;
        isSpectator = true;
        matched = true;
      }

      // Check team passwords (keys "0", "1", etc.)
      if (!matched) {
        for (const [key, pass] of Object.entries(this.passwords)) {
          if (key === 'spectator' || key === 'oversight') continue;
          if (password === pass) {
            teamId = parseInt(key);
            matched = true;
            break;
          }
        }
      }

      if (!matched) {
        return { success: false, reason: 'Invalid password' };
      }

      // In protected mode, check if this team slot is already taken
      if (!isSpectator && this.isTeamTaken(teamId)) {
        return { success: false, reason: 'Team slot already occupied' };
      }
    } else {
      // Legacy mode: single shared player password, client picks team
      // Support both old format {"players":"x","spectator":"y"} and
      // new format {"0":"x","1":"y","spectator":"z"}
      const playerPass = this.passwords.players || this.passwords['0'];
      const spectatorPass = this.passwords.spectator;

      if (password === playerPass) {
        // Player - try preferredTeam first, then fall back
        if (preferredTeam === 0 || preferredTeam === 1) {
          if (!this.isTeamTaken(preferredTeam)) {
            teamId = preferredTeam;
          } else if (!this.isTeamTaken(1 - preferredTeam)) {
            teamId = 1 - preferredTeam;
          } else {
            return { success: false, reason: 'Both teams are already taken' };
          }
        } else {
          if (!this.isTeamTaken(0)) {
            teamId = 0;
          } else if (!this.isTeamTaken(1)) {
            teamId = 1;
          } else {
            return { success: false, reason: 'Both teams are already taken' };
          }
        }
      } else if (password === spectatorPass) {
        teamId = -1;
        isSpectator = true;
      } else {
        return { success: false, reason: 'Invalid password' };
      }
    }

    if (info.authTimer) {
      clearTimeout(info.authTimer);
      info.authTimer = null;
    }

    const assignedName = this.generateUniqueName(name || `Player${teamId}`);

    info.authenticated = true;
    info.teamId = teamId;
    info.isSpectator = isSpectator;
    info.isOversight = isOversight;
    info.name = assignedName;

    // IMPORTANT: Never include the password in the return value
    return { success: true, teamId, assignedName, isSpectator, isOversight };
  }

  isTeamTaken(teamId) {
    for (const [, info] of this.connections) {
      if (info.authenticated && !info.isSpectator && info.teamId === teamId) {
        return true;
      }
    }
    return false;
  }

  getConnectionInfo(ws) {
    return this.connections.get(ws);
  }

  getPlayers() {
    const players = [];
    for (const [ws, info] of this.connections) {
      if (info.authenticated && !info.isSpectator) {
        players.push({ ws, ...info });
      }
    }
    return players;
  }

  getSpectators() {
    const spectators = [];
    for (const [ws, info] of this.connections) {
      if (info.authenticated && info.isSpectator) {
        spectators.push({ ws, ...info });
      }
    }
    return spectators;
  }

  getPlayerByTeam(teamId) {
    for (const [ws, info] of this.connections) {
      if (info.authenticated && !info.isSpectator && info.teamId === teamId) {
        return { ws, ...info };
      }
    }
    return null;
  }

  bothTeamsConnected() {
    return this.getPlayerByTeam(0) !== null && this.getPlayerByTeam(1) !== null;
  }

  getConnectedClients() {
    const clients = [];
    for (const [, info] of this.connections) {
      if (info.authenticated) {
        clients.push({
          name: info.name,
          type: info.isSpectator ? 'spectator' : 'player',
          team: info.isSpectator ? undefined : info.teamId,
        });
      }
    }
    return clients;
  }

  send(ws, message) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const [ws, info] of this.connections) {
      if (info.authenticated && ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  broadcastToPlayers(message) {
    const data = JSON.stringify(message);
    for (const [ws, info] of this.connections) {
      if (info.authenticated && !info.isSpectator && ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  broadcastToSpectators(message) {
    const data = JSON.stringify(message);
    for (const [ws, info] of this.connections) {
      if (info.authenticated && info.isSpectator && ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  getOversightClient() {
    for (const [ws, info] of this.connections) {
      if (info.authenticated && info.isOversight && ws.readyState === ws.OPEN) {
        return { ws, ...info };
      }
    }
    return null;
  }

  sendToTeam(teamId, message) {
    const data = JSON.stringify(message);
    for (const [ws, info] of this.connections) {
      if (info.authenticated && !info.isSpectator && info.teamId === teamId && ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  sendToOversight(message) {
    const client = this.getOversightClient();
    if (client) {
      this.send(client.ws, message);
      return true;
    }
    return false;
  }
}

module.exports = { ConnectionManager };
