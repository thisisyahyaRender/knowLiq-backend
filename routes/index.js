require("dotenv").config();
const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const fs = require("fs").promises;
const path = require("path");
const verifyLogin = require("../middlewares/verifyLogin.js");
// Use Capitalized name for Mongoose models by convention
const PastPaper = require("../models/PastPaper.js");
const User = require('../models/User');
const Chat = require("../models/Chat");
const Workspace = require("../models/Workspace");

const { pdf } = require("pdf-to-img");
const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const uid = req.uid;

      const pdf_directory = path.join("uploads", String(uid));
      const pages_directory = path.join(pdf_directory, "pages");

      // Creating the child directory with recursive: true automatically creates pdf_directory too
      await fs.mkdir(pages_directory, { recursive: true });

      // multer saves the uploaded PDF in the pdf_directory
      cb(null, pdf_directory);
    } catch (error) {
      cb(error);
    }
  },

  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });


router.post("/process", verifyLogin, upload.single("file"), async (req, res, next) => {
  const { uid } = req;
  const userUploadDir = path.resolve("uploads", String(uid));

  try {
    console.log("in /process : route hit, starting processing...");

    const { subject } = req.body;

    if (!req.file) {
      console.log("in /process : no file uploaded");
      return res.status(400).json({ 
        success: "false", 
        error: "No file uploaded" 
      });
    }

    if (!subject) {
      console.log("in /process : subject not provided in form data");
      return res.status(400).json({ 
        success: "false", 
        error: "Subject is required" 
      });
    }

    console.log(`in /process : file received - ${req.file.originalname} for subject: ${subject}`);

    const user = await User.findOne({ uid }, "workspaces");
    if (!user) {
      console.log("in /process : user doesn't exist in Database");
      return res.status(404).json({ 
        success: "false", 
        error: "User not found in database" 
      });
    }

    // Safety check: verify subject DOES NOT already exist in user's workspaces
    const workspaceExists = Array.isArray(user.workspaces) && user.workspaces.some((ws) => {
      if (typeof ws === "string") return ws.toLowerCase() === subject.toLowerCase();
      return (ws.name || ws.subject || "").toLowerCase() === subject.toLowerCase();
    });

    if (workspaceExists) {
      console.log(`in /process : workspace/subject '${subject}' already exists for this user`);
      return res.status(400).json({ 
        success: "false", 
        error: `Workspace '${subject}' already exists for this user` 
      });
    }

    const pagesDir = path.join(userUploadDir, "pages");

    
    console.log("in /process : starting PDF to Image conversion...");

    // Convert PDF document
    const document = await pdf(req.file.path, { scale: 2 });
    let pageIndex = 1;

    for await (const page of document) {
      const imagePath = path.join(pagesDir, `page-${pageIndex}.jpg`);
      await fs.writeFile(imagePath, page);
      pageIndex++;
    }

    console.log("in /process : PDF conversion complete");
    
    // Read and filter all JPG/JPEG files
    const allFiles = await fs.readdir(pagesDir);
    const imageFiles = allFiles
      .filter((file) => /\.(jpe?g)$/i.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (imageFiles.length === 0) {
      console.log("in /process : no images were generated");
      return res.status(400).json({ 
        success: "false", 
        error: "No images were generated from the PDF" 
      });
    }

    console.log(`in /process : found ${imageFiles.length} pages to process`);

    const allTopics = [];
    const BATCH_SIZE = 10;
    
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Process in batches of 10
    for (let i = 0; i < imageFiles.length; i += BATCH_SIZE) {
      const batchFiles = imageFiles.slice(i, i + BATCH_SIZE);
      console.log(`in /process : sending batch ${i / BATCH_SIZE + 1} (Pages ${i + 1} to ${i + batchFiles.length}) to OpenAI`);

      const formattedImages = await Promise.all(
        batchFiles.map(async (filename) => {
          const fileData = await fs.readFile(path.join(pagesDir, filename));
          return {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${fileData.toString("base64")}`,
              detail: "high"
            }
          };
        })
      );

      const completion = await openai.chat.completions.create({
        model: "gpt-5.6-luna",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "paper_topics",
            strict: true,
            schema: {
              type: "object",
              properties: {
                topics: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      topic: { type: "string" },
                      importance_score: { type: "number" },
                      times_appeared: { type: "integer" },
                      total_marks: { type: "number" },
                      subtopics: {
                        type: "array",
                        items: { type: "string" }
                      }
                    },
                    required: [
                      "topic",
                      "importance_score",
                      "times_appeared",
                      "total_marks",
                      "subtopics"
                    ],
                    additionalProperties: false
                  }
                }
              },
              required: ["topics"],
              additionalProperties: false
            }
          }
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyze all provided pages together and identify the academic topics appearing in the paper for the subject: ${subject}.

For each topic:
- importance_score: 0–1 based on how prominently it appears
- times_appeared: number of times it was tested
- total_marks: total marks associated with the topic
- subtopics: specific concepts covered

Merge closely related concepts.
Do not invent topics.
Return the requested JSON structure.`
              },
              ...formattedImages
            ]
          }
        ]
      });

      if (completion.usage) {
        totalInputTokens += completion.usage.prompt_tokens || 0;
        totalOutputTokens += completion.usage.completion_tokens || 0;
      }

      const batchResult = JSON.parse(completion.choices[0].message.content);
      
      if (batchResult.topics && Array.isArray(batchResult.topics)) {
        allTopics.push(...batchResult.topics);
      }
      
      console.log(`in /process : batch ${i / BATCH_SIZE + 1} completed successfully`);
    }

    console.log("in /process : all batches processed successfully");

    const INPUT_RATE_PER_MILLION = 0.20;
    const OUTPUT_RATE_PER_MILLION = 1.20;

    const estimatedInputCost = (totalInputTokens / 1_000_000) * INPUT_RATE_PER_MILLION;
    const estimatedOutputCost = (totalOutputTokens / 1_000_000) * OUTPUT_RATE_PER_MILLION;
    const totalCost = (estimatedInputCost + estimatedOutputCost).toFixed(5);

    console.log(`in /process : --- USAGE SUMMARY ---`);
    console.log(`in /process : Total Input Tokens:  ${totalInputTokens}`);
    console.log(`in /process : Total Output Tokens: ${totalOutputTokens}`);
    console.log(`in /process : Total Tokens Used:   ${totalInputTokens + totalOutputTokens}`);
    console.log(`in /process : Estimated Cost:      $${totalCost} USD`);
    console.log(`in /process : -----------------------`);

    // --- Create Workspace in Database ---
    try {
      // 1. Extract unique topic names
      const topicNames = [...new Set(allTopics.map(t => t.topic))];

      // 2. Transform subtopics string array into array of subtopic objects matching the new schema
      const formattedDetailedTopics = allTopics.map(item => {
        const formattedSubtopics = [];
        
        if (Array.isArray(item.subtopics)) {
          item.subtopics.forEach(sub => {
            if (sub && typeof sub === "string") {
              formattedSubtopics.push({
                name: sub.trim(),
                historical_score: 0,
                retention: 'untested', // Default retention state
                last_learned_at: null  // Never learned yet
              });
            }
          });
        }

        return {
          topic: item.topic,
          importance_score: item.importance_score || 0,
          times_appeared: item.times_appeared || 0,
          total_marks: item.total_marks || 0,
          subtopics: formattedSubtopics // Fits the new array-based subdocuments schema
        };
      });

      // 3. Create the new Workspace document
      const newWorkspace = new Workspace({
        owner: user._id,
        subject: subject,
        topicsToCover: topicNames,
        detailedTopics: formattedDetailedTopics
      });

      // 4. Save it to the database
      await newWorkspace.save();

      // 5. Update user's workspaces list
      await User.updateOne(
        { _id: user._id },
        { $push: { workspaces: subject } }
      );

      console.log(`in /process : successfully created Workspace document for '${subject}'`);
    } catch (dbError) {
      console.error(`in /process : Database creation failed - ${dbError.message}`);
      return res.status(500).json({
        success: "false",
        error: "Processed successfully, but failed to save workspace to database"
      });
    }

    console.log("in /process : Final Extracted Topics:");
    console.log(JSON.stringify(allTopics, null, 2));
    
    return res.status(200).json({ 
      success: "true", 
      message: "Processed successfully",
      totalPages: imageFiles.length,
      data: {
        topics: allTopics
      }
    });

  } catch (error) {
    console.error("in /process : Error processing PDF:", error);
    return res.status(500).json({ 
      success: "false", 
      error: "Failed to process PDF" 
    });
  } finally {
    try {
      await fs.rm(userUploadDir, { recursive: true, force: true });
      console.log(`in /process : cleaned up user directory: ${userUploadDir}`);
    } catch (cleanupErr) {
      console.error(`in /process : failed to delete upload directory: ${cleanupErr.message}`);
    }
  }
});


router.get("/fetch-workspaces", verifyLogin, async function (req, res) {
  try {
    const { uid } = req;
    
    // The second argument 'workspaces' tells Mongo to only fetch that specific field
    const user = await User.findOne({ uid }, 'workspaces');

    if (!user) {
      console.log("in /fetch-workspaces: user doesn't exist in Database");
      return res.status(404).json({ error: "User not found in database" });
    }

    console.log("returned workspaces ; 200");

    return res.status(200).json({ 
      success: true, 
      workspaces: user.workspaces 
    });

  } catch (error) {
    console.error("Error fetching workspaces:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});




router.get("/:subject", verifyLogin, async (req, res) => {
  try {
    // 1. Find the MongoDB User record by Firebase UID or use req.user._id (if verifyLogin sets it)
    const {uid} = req;
    const user = await User.findOne({  uid }); // or req.user._id if already on req.user
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // 2. Query workspace with the actual MongoDB ObjectId
    const workspace = await Workspace.findOne({
      owner: user._id,
      subject: req.params.subject
    });

    if (!workspace) {
      return res.status(404).json({ success: false, message: "Workspace not found" });
    }

    res.json({ success: true, workspace });
  } catch (error) {
    console.error("Fetch workspace error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});



router.delete("/delete-workspace/:subject", verifyLogin, async (req, res) => {
  try {
    const { uid } = req; 
    const subject = req.params.subject; 

    // 1. Find the User
    const user = await User.findOne({ uid }); 
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // 2. Delete the Workspace document
    const deletedWorkspace = await Workspace.findOneAndDelete({
      owner: user._id,
      subject: subject
    });

    if (!deletedWorkspace) {
      return res.status(404).json({ success: false, message: "Workspace not found" });
    }

    // 3. Delete all associated Chats
    await Chat.deleteMany({
      user: user._id,
      subject: subject
    });

    // 👉 4. NEW: Remove the workspace from the User's workspaces array
    await User.updateOne(
      { _id: user._id },
      { $pull: { workspaces: subject } } // $pull removes all matching strings from the array
    );

    res.json({ success: true, message: "Workspace, chats, and user reference deleted successfully" });
  } catch (error) {
    console.error("Delete workspace error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;