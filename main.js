const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let loginWindow;
let serverProcess;
let keyBlockerProcess;
let currentClassCode = null;
let isStudentMode = false;

autoUpdater.checkForUpdatesAndNotify();
const userDataPath = path.join(app.getPath('appData'), 'lockdown-calculator');
app.setPath('userData', userDataPath);

app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.chasegalloway.lockdown-calculator');
}

function sendKeyBlockerCommand(command) {
  try {
    const client = new net.Socket();
    client.connect(6741, '127.0.0.1', () => {
      client.write(command);
      client.destroy();
    });
    client.on('error', (err) => {
      console.log('KeyBlocker command failed (not running yet?):', err.message);
    });
    client.setTimeout(500, () => client.destroy());
  } catch (err) {
    console.log('Error sending KeyBlocker command:', err.message);
  }
}

function startKeyBlocker() {
  if (keyBlockerProcess) return;
  
  try {
    const keyBlockerPath = path.join(__dirname, 'KeyBlocker.exe');
    keyBlockerProcess = spawn(keyBlockerPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    
    keyBlockerProcess.unref();
    console.log('KeyBlocker started');
    
    setTimeout(() => {
      sendKeyBlockerCommand('UNBLOCK');
      console.log('Initial state: Windows key UNBLOCKED');
    }, 1500);
  } catch (err) {
    console.error('Error starting KeyBlocker:', err.message);
  }
}

function blockWindowsKey(enable) {
  if (enable) {
    console.log('Sending BLOCK command to KeyBlocker');
    sendKeyBlockerCommand('BLOCK');
  } else {
    console.log('Sending UNBLOCK command to KeyBlocker');
    sendKeyBlockerCommand('UNBLOCK');
  }
}

function startServer() {
  if (serverProcess) return;
  
  console.log('Starting server...');
  serverProcess = spawn('node', ['server.js'], {
    cwd: __dirname,
    stdio: 'inherit'
  });
  
  serverProcess.on('error', (err) => {
    console.error('Server process error:', err);
  });
  
  serverProcess.on('close', (code) => {
    console.log('Server process closed with code', code);
    serverProcess = null;
  });
  
  return new Promise(resolve => setTimeout(resolve, 2000));
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 500,
    height: 600,
    resizable: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  loginWindow.loadFile('login.html');
  loginWindow.setMenuBarVisibility(false);
}

function createMainWindow(role, data = {}) {
  const windowConfig = {
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  };

  if (role === 'student') {
    isStudentMode = true;
  }

  mainWindow = new BrowserWindow(windowConfig);
  
  if (role === 'teacher') {
    mainWindow.loadFile('teacher.html');
  } else {
    mainWindow.loadFile('student.html');
  }
  
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('did-finish-load', () => {
    if (role === 'teacher') {
      mainWindow.webContents.send('init-teacher', {
        classCode: data.code,
        serverAddress: data.serverAddress
      });
    } else {
      mainWindow.webContents.send('init-student', {
        classCode: data.code,
        studentName: data.studentName,
        serverAddress: data.serverAddress
      });
    }
  });

  if (role === 'student') {
    let isLocked = false;
    let focusInterval = null;
    let wasFocused = true;

    mainWindow.on('close', (e) => {
      if (!app.isQuitting && isLocked) {
        e.preventDefault();
        mainWindow.webContents.executeJavaScript(`
          alert('This window is locked. Please ask your teacher to unlock it first.');
        `);
      }
    });

    mainWindow.on('blur', () => {
      if (isLocked && wasFocused) {
        wasFocused = false;
        console.log('Student lost focus while locked (blur)');
        console.log('Sending IPC event: student-focus-lost');
        mainWindow.webContents.send('student-focus-lost', { detail: 'lost-focus' });
      }
    });

    mainWindow.on('focus', () => {
      if (isLocked && !wasFocused) {
        wasFocused = true;
        console.log('Student regained focus (focus)');
        console.log('Sending IPC event: student-focus-regained');
        mainWindow.webContents.send('student-focus-regained', { detail: 'regained-focus' });
      }
    });

    mainWindow.on('minimize', () => {
      if (isLocked) {
        console.log('Student minimized window while locked');
        console.log('Sending IPC event: student-focus-lost (minimized)');
        mainWindow.webContents.send('student-focus-lost', { detail: 'window-minimized' });
      }
    });

    mainWindow.on('restore', () => {
      if (isLocked) {
        console.log('Student restored window while locked');
        console.log('Sending IPC event: student-focus-regained (restored)');
        mainWindow.webContents.send('student-focus-regained', { detail: 'window-restored' });
      }
    });

    mainWindow.on('show', () => {
      if (isLocked && !wasFocused) {
        wasFocused = true;
        console.log('Student window shown');
        console.log('Sending IPC event: student-focus-regained (shown)');
        mainWindow.webContents.send('student-focus-regained', { detail: 'window-shown' });
      }
    });

    mainWindow.on('hide', () => {
      if (isLocked && wasFocused) {
        wasFocused = false;
        console.log('Student window hidden');
        console.log('Sending IPC event: student-focus-lost (hidden)');
        mainWindow.webContents.send('student-focus-lost', { detail: 'window-hidden' });
      }
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (isLocked && !url.includes('localhost') && !url.includes('desmos.com') && !url.includes('file://')) {
        event.preventDefault();
      }
    });

    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (isLocked) {
        const keyLower = input.key ? input.key.toLowerCase() : '';
        if (input.meta || keyLower === 'meta' || keyLower === 'super' || keyLower === 'win' || keyLower === 'os') {
          event.preventDefault();
          return;
        }
        if (input.control && input.key.toLowerCase() === 'w') {
          event.preventDefault();
        }
        if (input.alt && input.key === 'F4') {
          event.preventDefault();
        }
        if (input.key === 'F11') {
          event.preventDefault();
        }
        if (input.key === 'Escape' && mainWindow.isFullScreen()) {
          event.preventDefault();
        }
      }
      if (input.control && input.key.toLowerCase() === 'm') {
        mainWindow.minimize();
        event.preventDefault();
      }
    });

    ipcMain.on('set-student-lock', (event, locked) => {
      isLocked = locked;
      console.log(`Student window lock set to: ${isLocked}`);

      blockWindowsKey(locked);
      
      if (locked) {
        mainWindow.setFullScreen(true);
        mainWindow.setAlwaysOnTop(true);
        // Don't use auto-focus interval - it interferes with blur event detection
      } else {
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setFullScreen(false);

        if (focusInterval) {
          clearInterval(focusInterval);
          focusInterval = null;
        }
      }
    });
  }

  if (loginWindow) {
    loginWindow.close();
    loginWindow = null;
  }
}

ipcMain.on('store-class-code', (event, code) => {
  currentClassCode = code;
  console.log('Class code generated:', code);
});

ipcMain.on('close-student-window', (event) => {
  if (mainWindow) {
    app.isQuitting = true;
    mainWindow.close();
  }
});

ipcMain.on('return-to-login', (event) => {
  console.log('[MAIN] return-to-login received');
  if (mainWindow) {
    try {
      // Reset window state - order matters!
      console.log('[MAIN] Resetting window state...');
      mainWindow.setFullScreen(false);
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setMovable(true);
      mainWindow.setResizable(true);
      
      // Unblock keyboard if it was locked
      blockWindowsKey(false);
      
      // Reset size and position
      mainWindow.setSize(500, 600);
      mainWindow.center();
      
      // Clear any student-specific state
      isStudentMode = false;
      
      console.log('[MAIN] Loading login.html...');
      mainWindow.loadFile('login.html');
      mainWindow.show();
      mainWindow.focus();
      console.log('[MAIN] Window reset to login page');
    } catch (err) {
      console.error('[MAIN] Error during return-to-login:', err);
    }
  } else {
    console.log('[MAIN] mainWindow not available, creating new login window');
    createLoginWindow();
  }
});

ipcMain.on('start-app', async (event, data) => {
  createMainWindow(data.role, data);
});

app.whenReady().then(() => {
  startServer();
  startKeyBlocker();
  createLoginWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createLoginWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  blockWindowsKey(false); 
  if (serverProcess) {
    serverProcess.kill();
  }
});
