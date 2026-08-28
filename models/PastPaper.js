const mongoose = require("mongoose");

const paperSchema = new mongoose.Schema({
  // The subject/workspace it belongs to (e.g., "Physics A2")
   user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
  subject: { 
    type: String, 
    required: true,
    index: true // Indexed for faster standard queries
  },
  
  // The exam session/date (e.g., "May/June 2023" or "2023-05")
  date: { 
    type: String, 
    required: false 
  },
  
  // File metadata to trace back to the original upload
  fileName: { 
    type: String, 
    required: true 
  },
  pageNumber: { 
    type: Number, 
    required: true 
  },
  
  // The raw text/equations extracted by GPT-4o-mini
  original_text: { 
    type: String, 
    required: true 
  },
  
  // The 1536-dimensional vector from text-embedding-3-small
  embeddings: { 
    type: [Number], 
    required: true,
    validate: {
      validator: function(v) {
        return v.length === 1536;
      },
      message: "Embeddings must be exactly 1536 dimensions."
    }
  },

  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

// The third argument "past_papers" explicitly sets the MongoDB collection name
// to match the Vector Search index you created earlier.
module.exports = mongoose.model("Paper", paperSchema, "pastpapers");