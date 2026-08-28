const mongoose = require('mongoose');

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
test_Pending : {type : Boolean, default : false},

}, { 
  timestamps: true // Automatically adds createdAt and updatedAt dates
});

module.exports = mongoose.model('User', userSchema);