const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store active sessions
const sessions = new Map(); // classCode -> { teacherId, students: [] }
const users = new Map(); // socketId -> { role, classCode, name }

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Teacher creates a class
  socket.on('create-class', (data) => {
    const { classCode, teacherName } = data;
    
    const session = {
      teacherId: socket.id,
      teacherName: teacherName || 'Teacher',
      students: [],
      currentExpression: null,
      settings: {
        locked: true,
        allowedFeatures: []
      }
    };

    sessions.set(classCode, session);

    users.set(socket.id, {
      role: 'teacher',
      classCode: classCode,
      name: teacherName
    });

    socket.join(classCode);
    socket.emit('class-created', { classCode, session });
    console.log(`Class ${classCode} created by ${socket.id}`);
  });

  // Validate if a class code exists and teacher is online
  socket.on('validate-class-code', (classCode, callback) => {
    const session = sessions.get(classCode);
    
    if (!session) {
      console.log(`Validation failed: class ${classCode} not found`);
      callback(false);
      return;
    }
    
    // Check if teacher is still connected
    const teacherSocket = io.sockets.sockets.get(session.teacherId);
    if (!teacherSocket) {
      console.log(`Validation failed: teacher for class ${classCode} is disconnected`);
      sessions.delete(classCode);
      callback(false);
      return;
    }
    
    console.log(`Validation successful: class ${classCode} is active`);
    callback(true);
  });

  // Student joins a class
  socket.on('join-class', (data) => {
    const { classCode, studentName } = data;
    const session = sessions.get(classCode);

    // Validate class code exists and teacher is still connected
    if (!session) {
      console.log(`Student join rejected: class ${classCode} not found`);
      socket.emit('join-error', { message: 'Invalid class code or class does not exist' });
      return;
    }

    // Check if teacher is still connected
    const teacherSocket = io.sockets.sockets.get(session.teacherId);
    if (!teacherSocket) {
      console.log(`Student join rejected: teacher disconnected for class ${classCode}`);
      socket.emit('join-error', { message: 'Teacher is not currently hosting this class' });
      sessions.delete(classCode);
      return;
    }

    const studentInfo = {
      id: socket.id,
      name: studentName || `Student ${session.students.length + 1}`,
      joinedAt: new Date().toLocaleTimeString()
    };

    session.students.push(studentInfo);
    
    users.set(socket.id, {
      role: 'student',
      classCode: classCode,
      name: studentInfo.name
    });

    socket.join(classCode);
    socket.emit('join-success', { 
      classCode,
      settings: session.settings 
    });

    // Notify teacher of new student
    console.log(`Notifying teacher ${session.teacherId} of new student`);
    io.to(session.teacherId).emit('student-joined', {
      student: studentInfo,
      totalStudents: session.students.length,
      allStudents: session.students
    });

    console.log(`${studentInfo.name} joined class ${classCode}`);
  });

  // Teacher sends expression/command to all students
  socket.on('broadcast-to-students', (data) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'teacher') {
      console.log('Broadcast rejected: invalid user or not teacher');
      return;
    }

    const session = sessions.get(user.classCode);
    if (!session) {
      console.log('Broadcast rejected: session not found');
      return;
    }

    // Broadcast to all students in the class
    console.log(`Broadcasting to class ${user.classCode}: ${data.type} to ${session.students.length} students`);
    console.log('Student IDs in session:', session.students.map(s => s.id));
    
    // Send to each student individually to ensure delivery
    session.students.forEach(student => {
      console.log(`Sending ${data.type} to student ${student.id} (${student.name})`);
      io.to(student.id).emit('teacher-command', data);
    });
    
    console.log(`Teacher broadcast complete for class ${user.classCode}:`, data.type);
  });

  // Teacher sends command to specific student
  socket.on('send-to-student', (data) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'teacher') {
      console.log('Send-to-student rejected: invalid user or not teacher');
      return;
    }

    const { studentId, command } = data;
    console.log(`Teacher ${socket.id} sending command ${command.type} to student ${studentId}`);
    
    const studentSocket = io.sockets.sockets.get(studentId);
    if (!studentSocket) {
      console.log(`Student ${studentId} not found or disconnected`);
      return;
    }
    
    console.log(`Emitting ${command.type} to student ${studentId}`);
    io.to(studentId).emit('teacher-command', command);
    console.log(`Command emitted successfully to student ${studentId}`);
  });

  // Teacher updates class settings
  socket.on('update-settings', (settings) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'teacher') return;

    const session = sessions.get(user.classCode);
    if (!session) return;

    session.settings = { ...session.settings, ...settings };
    socket.to(user.classCode).emit('settings-updated', session.settings);
  });

  // Teacher requests student list
  socket.on('get-students', () => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'teacher') return;

    const session = sessions.get(user.classCode);
    if (!session) return;

    socket.emit('student-list', { students: session.students });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;

    if (user.role === 'teacher') {
      // Teacher disconnected - notify all students and end session
      const session = sessions.get(user.classCode);
      if (session) {
        io.to(user.classCode).emit('teacher-disconnected');
        sessions.delete(user.classCode);
        console.log(`Class ${user.classCode} ended - teacher disconnected`);
      }
    } else if (user.role === 'student') {
      // Student disconnected - notify teacher
      const session = sessions.get(user.classCode);
      if (session) {
        session.students = session.students.filter(s => s.id !== socket.id);
        io.to(session.teacherId).emit('student-left', {
          studentId: socket.id,
          totalStudents: session.students.length,
          allStudents: session.students
        });
        console.log(`${user.name} left class ${user.classCode}`);
      }
    }

    users.delete(socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log('WebSocket server ready for connections');
});

// Export for Vercel serverless
module.exports = app;
