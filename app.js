require('dotenv').config();
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var mongoose = require('mongoose');
var cors = require('cors');
var admin = require('firebase-admin');

// --- 1. FIREBASE ADMIN SETUP ---
// Make sure firebase-secrets.json is saved in the same folder as this app.js
const { initializeApp, cert } = require('firebase-admin/app');
const serviceAccount = require('./firebase-secrets.json');
initializeApp({
  credential: cert(serviceAccount)
});

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
const chatRouter = require("./routes/chatRouter");

var app = express();

// --- 2. MONGODB CONNECTION ---
if (!process.env.MONGODB_URI) {
  console.error("❌ MONGO_URI is missing in your .env file.");
  process.exit(1); 
}

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));

// --- 3. CORS SETUP ---
// Only allow requests from your React frontend on port 5173
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));



// --- 5. STANDARD ROUTES ---
app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/auth', require("./routes/auth"));
app.use('/test', require("./routes/testRouter"));
app.use('/chat', chatRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;