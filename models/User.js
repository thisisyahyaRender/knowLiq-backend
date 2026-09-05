const mongoose = require('mongoose');



// New Settings Schema to keep the main user object clean
const userSettingsSchema = new mongoose.Schema(
  {
    learnerType: { type: String, default: 'visual' },
    preferredLanguage: { type: String, default: 'English' },
    fieldOfStudy: { type: String, default: 'technical' },
    answerStructure: { type: String, default: 'normal' },
    theme: { type: String, default: 'dark' }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema({
  uid: { 
    type: String, 
    required: true, 
    unique: true 
  },
  email: { 
    type: String, 
    required: true, 
    unique: true 
  },
  displayName: { 
    type: String 
  },
  photoURL: { 
    type: String 
  },
  workspaces: [{
    type: String,
    trim: true
  }],
  
  // Embed the settings schema, and initialize it automatically for new users
  settings: { 
    type: userSettingsSchema, 
    default: () => ({}) 
  }
}, { 
  timestamps: true // Automatically adds createdAt and updatedAt dates
});

module.exports = mongoose.model('User', userSchema);