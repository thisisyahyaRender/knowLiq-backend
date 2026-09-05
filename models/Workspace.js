const mongoose = require("mongoose");


const currentFocusSchema = new mongoose.Schema(
  {
    topic: { type: String, required: true, trim: true },
    counter: { type: Number, default: 0 },
    started_at: { type: Date, default: Date.now },
  },
  { _id: false } // Correctly disables auto-generated _id
);

// 1. Sub-schema for persistent subtopic state
const subtopicSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  historical_score: {
    type: Number,
    default: 0
  },
  retention: {
    type: String,
    enum: ['red', 'yellow', 'green', 'untested'],
    default: 'untested'
  },
  remarks: { type: String, default: "" },
  last_learned_at: {
    type: Date,
    default: null
  }
}, { _id: false });

// 2. Extracted topic sub-schema
const extractedTopicSchema = new mongoose.Schema({
  topic: {
    type: String,
    required: true
  },
  importance_score: {
    type: Number,
    default: 0
  },
  times_appeared: {
    type: Number,
    default: 0
  },
  total_marks: {
    type: Number,
    default: 0
  },
  subtopics: [subtopicSchema]
}, { _id: false });

// 3. Main Workspace Schema
const workspaceSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  subject: {
    type: String,
    required: true,
    trim: true
  },
  currentFocus: [currentFocusSchema],
  currentFocusSummary: {
    text: { type: String, default: "" },
    counter: { type: Number, default: 1 },
  },
  test_pending: { type: Boolean, default: false },

  shared: { type: Boolean, default: false },
  topicsToCover: [{
    type: String
  }],
  detailedTopics: [extractedTopicSchema],
  test_evaluations: [{
    type: String,
    trim: true
  }],
}, {
  timestamps: true
});

workspaceSchema.index({ owner: 1, subject: 1 }, { unique: true });

const Workspace = mongoose.model("Workspace", workspaceSchema);

module.exports = Workspace;