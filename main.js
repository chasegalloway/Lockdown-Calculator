const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let loginWindow;
let serverProcess;
let currentClassCode = null;
let isStudentMode = false;

// Configure auto-updater
autoUpdater.checkForUpdatesAndNotify();
// Set user data directory to avoid cache permission errors
const userDataPath = path.join(app.getPath('appData'), 'lockdown-calculator');
app.setPath('userData', userDataPath);

// Ignore certificate errors for local network connections
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');

// Start the server
function startServer() {
  if (serverProcess) return; // Server already running
  
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
  
  // Wait a moment for server to start
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

  // If student mode, enable kiosk-like behavior
  if (role === 'student') {
    isStudentMode = true;
    windowConfig.fullscreen = true;
    windowConfig.kiosk = false;
    windowConfig.frame = true; // Keep frame but fullscreen hides it
    windowConfig.alwaysOnTop = true;
  }

  mainWindow = new BrowserWindow(windowConfig);
  
  // Load appropriate file based on role
  if (role === 'teacher') {
    mainWindow.loadFile('teacher.html');
  } else {
    mainWindow.loadFile('student.html');
  }
  
  mainWindow.setMenuBarVisibility(false);

  // Send initialization data after window loads
  mainWindow.webContents.on('did-finish-load', () => {
    if (role === 'teacher') {
      mainWindow.webContents.send('init-teacher', {
        classCode: data.code,
        serverAddress: data.serverAddress || 'http://localhost:3000'
      });
    } else {
      mainWindow.webContents.send('init-student', {
        classCode: data.code,
        studentName: data.studentName,
        serverAddress: data.serverAddress || 'localhost:3000'
      });
    }
  });

  // Prevent student from closing the window
  if (role === 'student') {
    let isLocked = true; // Start locked
    let focusInterval = null;

    mainWindow.on('close', (e) => {
      if (!app.isQuitting && isLocked) {
        e.preventDefault();
        mainWindow.webContents.executeJavaScript(`
          alert('This window is locked. Please ask your teacher to close it.');
        `);
      }
    });

    // If focus is lost while locked, immediately refocus the window
    mainWindow.on('blur', () => {
      if (isLocked) {
        mainWindow.focus();
      }
    });

    // Prevent navigation away
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (isLocked && !url.includes('localhost') && !url.includes('desmos.com') && !url.includes('file://')) {
        event.preventDefault();
      }
    });

    // Disable keyboard shortcuts (but allow Ctrl+M to minimize for testing)
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (isLocked) {
        // Block Windows key and meta combos to keep taskbar/start menu hidden
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
      // Allow Ctrl+M to minimize for testing purposes
      if (input.control && input.key.toLowerCase() === 'm') {
        mainWindow.minimize();
        event.preventDefault();
      }
    });

    // IPC handler to lock/unlock student
    ipcMain.on('set-student-lock', (event, locked) => {
      isLocked = locked;
      console.log(`Student window lock set to: ${isLocked}`);
      
      if (locked) {
        // Lock: fullscreen hides title bar, always on top
        mainWindow.setFullScreen(true);
        mainWindow.setAlwaysOnTop(true);

        // Start aggressive refocus loop to stay above Start/taskbar
        if (!focusInterval) {
          focusInterval = setInterval(() => {
            if (mainWindow && !mainWindow.isFocused()) {
              mainWindow.focus();
            }
          }, 500);
        }
      } else {
        // Unlock: exit fullscreen shows title bar with controls, not always on top
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setFullScreen(false);

        // Stop refocus loop when unlocked
        if (focusInterval) {
          clearInterval(focusInterval);
          focusInterval = null;
        }
      }
    });
  }

  // Close login window after main window opens
  if (loginWindow) {
    loginWindow.close();
    loginWindow = null;
  }
}

// IPC handlers
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
  // Return to login screen by reloading the login.html file
  if (mainWindow) {
    mainWindow.loadFile('login.html');
    // Resize window back to login size
    mainWindow.setSize(500, 600);
    // Unlock the window so they can interact with login
    mainWindow.setFullScreen(false);
    mainWindow.setAlwaysOnTop(false);
  }
});

ipcMain.on('start-app', async (event, data) => {
  // No longer starting local server - using Render hosted server
  createMainWindow(data.role, data);
});

app.whenReady().then(() => {
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
  // Kill server process when app quits
  if (serverProcess) {
    serverProcess.kill();
  }
});
