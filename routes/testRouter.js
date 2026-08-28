
require("dotenv").config();
var express = require('express');
var router = express.Router();


const multer = require("multer");
const OpenAI = require("openai");
const fs = require("fs").promises;
const path = require("path");
const verifyLogin = require("../middlewares/verifyLogin.js");
// Use Capitalized name for Mongoose models by convention
const PastPaper = require("../models/PastPaper.js");
const User = require('../models/User');
const Workspace = require("../models/Workspace");
const pdfPoppler = require("pdf-poppler");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

router.post("/make-test", verifyLogin, async (req, res) => {
  try {
    console.log("in /make-test : route hit, generating test...");

    const { uid } = req;
    const { subject } = req.body;

    if (!subject) {
      console.log("in /make-test : validation failed - missing subject");
      return res.status(400).json({ success: "false", error: "Subject is required" });
    }

    // 1. Fetch User & Workspace
    console.log("in /make-test : fetching user and workspace...");
    const user = await User.findOne({ uid });
    if (!user) {
      return res.status(404).json({ success: "false", error: "User not found" });
    }

    const workspace = await Workspace.findOne({ owner: user._id, subject: subject.trim() });
    if (!workspace) {
      return res.status(404).json({ success: "false", error: "Workspace not found" });
    }

    // 2. Prepare Data for AI
    // We send the detailed topics so the AI sees the current scores (initially 0)
    const topicsData = JSON.stringify(workspace.detailedTopics, null, 2);

    const systemPrompt = `You are an expert academic examiner designing a diagnostic test for the subject: "${subject}".
    
You are provided with the student's extracted topics, subtopics, and their current mastery scores (0 to 1). 
Your task is to generate exactly 5 to 6 powerful questions.

CORE RULES:
1. Target areas for improvement: Look at the scores (0 means completely untested/unknown). Target high-importance topics or foundational subtopics first.
2. Synthesize concepts: Topics often depend on each other. You may formulate questions that span multiple subtopics to test deep understanding and boundaries.
3. Check familiarity: The questions should be challenging enough to expose the edges of the student's conceptual knowledge, not just basic recall.
4. Return ONLY a valid JSON object matching the strict schema.`;

    // 3. Call OpenAI (gpt-5.6-sol) with Structured Outputs
    console.log("in /make-test : sending request to OpenAI (gpt-5.6-sol)...");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "test_generation",
          strict: true,
          schema: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                description: "An array of 5 to 6 test questions.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    text: {
                      type: "string",
                      description: "The actual question text testing the user's boundaries."
                    },
                    target_topics: {
                      type: "array",
                      items: { type: "string" },
                      description: "List of subtopics this question evaluates."
                    }
                  },
                  required: ["id", "text", "target_topics"],
                  additionalProperties: false
                }
              }
            },
            required: ["questions"],
            additionalProperties: false
          }
        }
      },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Student's Topic Data:\n${topicsData}` }
      ]
    });

    // 4. Token & Cost Logging
    if (completion.usage) {
      const inputTokens = completion.usage.prompt_tokens || 0;
      const outputTokens = completion.usage.completion_tokens || 0;
      const totalTokens = completion.usage.total_tokens || (inputTokens + outputTokens);

      const INPUT_RATE_PER_MILLION = 4.00;
      const OUTPUT_RATE_PER_MILLION = 12.0;

      const estimatedInputCost = (inputTokens / 1_000_000) * INPUT_RATE_PER_MILLION;
      const estimatedOutputCost = (outputTokens / 1_000_000) * OUTPUT_RATE_PER_MILLION;
      const totalCost = (estimatedInputCost + estimatedOutputCost).toFixed(6);

      console.log(`in /make-test : --- USAGE SUMMARY ---`);
      console.log(`in /make-test : Input Tokens:  ${inputTokens}`);
      console.log(`in /make-test : Output Tokens: ${outputTokens}`);
      console.log(`in /make-test : Total Tokens:  ${totalTokens}`);
      console.log(`in /make-test : Estimated Cost: $${totalCost} USD`);
      console.log(`in /make-test : -----------------------`);
    }

    // 5. Parse and Return
    const parsedResponse = JSON.parse(completion.choices[0].message.content);
    console.log(`in /make-test : successfully generated ${parsedResponse.questions.length} questions.`);

    return res.status(200).json({
      success: "true",
      questions: parsedResponse.questions
    });

  } catch (error) {
    console.error("in /make-test : CRITICAL ERROR:", error);
    return res.status(500).json({
      success: "false",
      error: "Failed to generate test. Internal server error."
    });
  }
});



router.post("/submit-test", verifyLogin, async (req, res) => {
  try {
    console.log("in /submit-test : route hit, grading test...");

    const { uid } = req;
    const { subject, submissions } = req.body;

    // 1. Input Validation
    if (!subject) {
      console.log("in /submit-test : validation failed - missing subject");
      return res.status(400).json({ success: "false", error: "Subject is required" });
    }
    if (!submissions || !Array.isArray(submissions) || submissions.length === 0) {
      console.log("in /submit-test : validation failed - missing or invalid submissions");
      return res.status(400).json({ success: "false", error: "Submissions array is required" });
    }

    // 2. Fetch User & Workspace
    console.log("in /submit-test : fetching user and workspace...");
    const user = await User.findOne({ uid });
    if (!user) {
      return res.status(404).json({ success: "false", error: "User not found" });
    }

    const workspace = await Workspace.findOne({ owner: user._id, subject: subject.trim() });
    if (!workspace) {
      return res.status(404).json({ success: "false", error: "Workspace not found" });
    }

    // Prepare inputs for AI
    const syllabusData = JSON.stringify(workspace.detailedTopics, null, 2);
    const userSubmissionsData = JSON.stringify(submissions, null, 2);

    const systemPrompt = `You are an objective, strict academic grading engine designed to prevent grade inflation. Your task is to evaluate the student's test answers against academic standards and assign a calibrated mastery score between 0.00 and 1.00 for each evaluated subtopic.

### CALIBRATION BENCHMARKS:
- 1.00: Flawless, completely accurate, covers all critical nuances and correct terminology.
- 0.80 - 0.90: Conceptually solid, correct reasoning, but minor phrasing flaws or tiny omitted details.
- 0.60 - 0.75: Understands the main idea, but misses a key step, formula detail, or secondary condition.
- 0.40 - 0.55: Displays partial understanding; recognizes concepts but omits half the core components or makes substantial calculation/logic errors.
- 0.20 - 0.35: Mentions relevant keywords or formulas but shows fundamentally flawed reasoning.
- 0.00 - 0.15: Completely incorrect, blank, hallucinatory, or completely irrelevant/off-topic.

### GRADING PROTOCOL:
1. Analyze each question and answer step-by-step.
2. Explicitly note what the student got right, what was omitted, and what was incorrect (in evaluation_notes).
3. Map the performance directly to the relevant subtopic in the syllabus.
4. Output the precise score (e.g., 0.85, 0.40, 0.65) reflecting the severity of errors based strictly on the benchmarks above.
5. Return ONLY a valid JSON object matching the strict schema.`;

    // 3. Call OpenAI (gpt-5.6-luna) with Structured Outputs
    console.log("in /submit-test : sending request to OpenAI (gpt-5.6-luna) for grading...");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "test_grading",
          strict: true,
          schema: {
            type: "object",
            properties: {
              updated_subtopics: {
                type: "array",
                description: "List of evaluated subtopics with calibrated mastery scores.",
                items: {
                  type: "object",
                  properties: {
                    topic_name: { 
                      type: "string", 
                      description: "The exact name of the parent topic." 
                    },
                    subtopic_name: { 
                      type: "string", 
                      description: "The exact name of the subtopic." 
                    },
                    evaluation_notes: {
                      type: "string",
                      description: "Brief analysis of student errors and reasoning for deductions."
                    },
                    new_score: { 
                      type: "number", 
                      description: "The calibrated mastery score from 0.00 to 1.00." 
                    }
                  },
                  required: ["topic_name", "subtopic_name", "evaluation_notes", "new_score"],
                  additionalProperties: false
                }
              }
            },
            required: ["updated_subtopics"],
            additionalProperties: false
          }
        }
      },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Syllabus Data:\n${syllabusData}\n\nStudent Submissions:\n${userSubmissionsData}` }
      ]
    });

    // 4. Token & Cost Logging
    if (completion.usage) {
      const inputTokens = completion.usage.prompt_tokens || 0;
      const outputTokens = completion.usage.completion_tokens || 0;
      const totalTokens = completion.usage.total_tokens || (inputTokens + outputTokens);

      const INPUT_RATE_PER_MILLION = 0.20;
      const OUTPUT_RATE_PER_MILLION = 1.20;

      const estimatedInputCost = (inputTokens / 1_000_000) * INPUT_RATE_PER_MILLION;
      const estimatedOutputCost = (outputTokens / 1_000_000) * OUTPUT_RATE_PER_MILLION;
      const totalCost = (estimatedInputCost + estimatedOutputCost).toFixed(6);

      console.log(`in /submit-test : --- USAGE SUMMARY ---`);
      console.log(`in /submit-test : Input Tokens:  ${inputTokens}`);
      console.log(`in /submit-test : Output Tokens: ${outputTokens}`);
      console.log(`in /submit-test : Total Tokens:  ${totalTokens}`);
      console.log(`in /submit-test : Estimated Cost: $${totalCost} USD`);
      console.log(`in /submit-test : -----------------------`);
    }

    // 5. Parse AI Response
    const parsedResponse = JSON.parse(completion.choices[0].message.content);
    const updates = parsedResponse.updated_subtopics || [];
    
    console.log(`in /submit-test : AI evaluated ${updates.length} subtopics.`);

    // 6. Update MongoDB Workspace Document
    if (updates.length > 0) {
      console.log("in /submit-test : updating workspace subtopic scores in DB...");
      
      let isModified = false;

      updates.forEach((update) => {
        // Find the parent topic in the detailedTopics array
        const topicDoc = workspace.detailedTopics.find(t => t.topic === update.topic_name);
        
        if (topicDoc && topicDoc.subtopicScores) {
          // Verify this subtopic actually exists in our Map before updating
          if (topicDoc.subtopicScores.has(update.subtopic_name)) {
            // Mongoose Map '.set()' triggers tracking for updates
            topicDoc.subtopicScores.set(update.subtopic_name, update.new_score);
            isModified = true;
          }
        }
      });

      // Save the document if changes were made
      if (isModified) {
        await workspace.save();
        console.log("in /submit-test : workspace scores successfully updated and saved.");
      } else {
        console.log("in /submit-test : no matching topics/subtopics found to update.");
      }
    }

    // 7. Return Response
    return res.status(200).json({
      success: "true",
      message: "Test graded and workspace updated successfully.",
      graded_results: updates
    });

  } catch (error) {
    console.error("in /submit-test : CRITICAL ERROR:", error);
    return res.status(500).json({ 
      success: "false", 
      error: "Failed to submit and grade test. Internal server error." 
    });
  }
});


module.exports = router;
