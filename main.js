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

function sendKeyBlockerCommand(command) {
  try {
    const client = new net.Socket();
    client.connect(9876, '127.0.0.1', () => {
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
    
    // Give it time to start listening
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
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  };

  if (role === 'student') {
    isStudentMode = true;
    windowConfig.fullscreen = true;
    windowConfig.kiosk = false;
    windowConfig.frame = true;
    windowConfig.alwaysOnTop = true;
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
    let isLocked = true;
    let focusInterval = null;

    mainWindow.on('close', (e) => {
      if (!app.isQuitting && isLocked) {
        e.preventDefault();
        mainWindow.webContents.executeJavaScript(`
          alert('This window is locked. Please ask your teacher to close it.');
        `);
      }
    });

    mainWindow.on('blur', () => {
      if (isLocked) {
        mainWindow.focus();
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
      
      // Control Windows key blocking
      blockWindowsKey(locked);
      
      if (locked) {
        mainWindow.setFullScreen(true);
        mainWindow.setAlwaysOnTop(true);

        if (!focusInterval) {
          focusInterval = setInterval(() => {
            if (mainWindow && !mainWindow.isFocused()) {
              mainWindow.focus();
            }
          }, 500);
        }
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
  if (mainWindow) {
    mainWindow.loadFile('login.html');
    mainWindow.setSize(500, 600);
    mainWindow.setFullScreen(false);
    mainWindow.setAlwaysOnTop(false);
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
  blockWindowsKey(false); // Ensure Windows key is re-enabled
  if (serverProcess) {
    serverProcess.kill();
  }
});
