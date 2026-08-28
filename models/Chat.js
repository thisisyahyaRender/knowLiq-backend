const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true, // Only index on the user field
    },
    subject: {
      type: String,
      required: true, 
      index: true,
    },
    
    query: {
      type: String,
      required: true,
      trim: true,
    },
    answer: {
      type: String,
      default: '',
    },
    date: {
      type: Date,
      default: Date.now,
    },
    error: {
      type: String,
      default: null,
    },
    success: {
      type: Boolean,
      default: true,
    },
    // Add this inside your chatSchema definition in models/Chat.js
embeddings: {
  type: [Number],
  required: false, // False so failed AI calls can still be logged without crashing
},
  },
  {
    timestamps: true,
  }
);

// Removed the compound index: chatSchema.index({ user: 1, thread: 1, date: -1 });

const Chat = mongoose.model('Chat', chatSchema);

module.exports = Chat;