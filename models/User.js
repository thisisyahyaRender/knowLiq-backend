const mongoose = require('mongoose');

const currentTopicSchema = new mongoose.Schema(
  {
    topic: { type: String, required: true, trim: true },
    counter: { type: Number, default: 0 }
  },
  { _id: false } // Correctly disables auto-generated _id
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

currentTopics: [currentTopicSchema],

test_Pending : {type : Boolean, default : false},

}, { 
  timestamps: true // Automatically adds createdAt and updatedAt dates
});

module.exports = mongoose.model('User', userSchema);