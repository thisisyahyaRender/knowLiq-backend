
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
const Chat = require("../models/Chat.js");
const Test = require("../models/Test"); // Adjust path if necessary
// const pdfPoppler = require("pdf-poppler");

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

    // --- SAFETY CHECK ---
    if (user.test_pending !== true) {
      console.log("in /make-test : safety check failed - test_pending is false");
      return res.status(403).json({ 
        success: "false", 
        error: "No test is pending for this user." 
      });
    }

    const workspace = await Workspace.findOne({ owner: user._id, subject: subject.trim() });
    if (!workspace) {
      return res.status(404).json({ success: "false", error: "Workspace not found" });
    }

    // 2. Extract allowed topics and the started_at timestamp
    const allowedTopics = user.currentTopics ? user.currentTopics.map((m) => m.topic) : [];
    const startedAt = user.currentTopics?.[0]?.started_at;

    // 3. Query chats created on or after started_at
    console.log("in /make-test : querying recent chats...");
    const chats = await Chat.find(
      {
        user: user._id,
        subject: subject,
        ...(startedAt && { date: { $gte: startedAt } }),
      },
      {
        query: 1,
        answer: 1,
        _id: 0,
      }
    )
      .sort({ date: 1 })
      .limit(100);

    // 4. STEP 1: Summarize chat history into pure text (no JSON)
    let chatSummaryText = "No recent study chat history available.";

    if (chats.length > 0) {
      console.log(`in /make-test : summarizing ${chats.length} chat interactions...`);
      const conversationText = chats
        .map((c, i) => `Turn ${i + 1}:\nStudent Question: ${c.query}\nAssistant Answer: ${c.answer}`)
        .join("\n\n");

      const summaryCompletion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an academic analysis assistant. Summarize the student's conversation history regarding "${subject}". Focus on concepts discussed, areas where the student had confusion or gaps, and their general level of understanding. Return your summary as pure, concise plain text with NO JSON formatting, NO markdown fences, and NO bullet lists.`,
          },
          {
            role: "user",
            content: `Student Chat History:\n\n${conversationText}`,
          },
        ],
      });

      chatSummaryText = summaryCompletion.choices[0].message.content.trim();
    }

    // 5. STEP 2: Generate Structured Test Questions (5 to 9 questions)
    console.log("in /make-test : sending request to OpenAI for structured test generation...");
    const systemPrompt = `You are an expert academic examiner designing a diagnostic test for the subject: "${subject}".

STRICT TOPIC CONSTRAINT:
You MUST ONLY create questions and assign "target_topics" strictly from this explicit allowed list of topics:
${JSON.stringify(allowedTopics, null, 2)}
Do NOT include, test, or mention any topics or subtopics outside of this list.

RULES FOR QUESTIONS:
1. Generate between 5 and 9 questions (minimum 5, maximum 9).
2. Use the provided study chat summary to identify weak points, gaps, and areas tested during their study session.
3. Formulate deep conceptual and diagnostic questions to test the student's boundaries.
4. Return ONLY a valid JSON object strictly matching the provided schema.`;

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
                description: "An array of 5 to 9 test questions.",
                items: {
                  type: "object",
                  properties: {
                    question_id: { 
                      type: "integer",
                      description: "Sequential question number starting from 1." 
                    },
                    text: {
                      type: "string",
                      description: "The actual diagnostic question text.",
                    },
                    target_topics: {
                      type: "array",
                      items: { type: "string" },
                      description: "List of topics from the allowed list evaluated by this question.",
                    },
                  },
                  required: ["question_id", "text", "target_topics"],
                  additionalProperties: false,
                },
              },
            },
            required: ["questions"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Allowed Topics:\n${JSON.stringify(allowedTopics, null, 2)}\n\nRecent Study History Summary:\n${chatSummaryText}`,
        },
      ],
    });

    // 6. Token & Cost Logging
    if (completion.usage) {
      const inputTokens = completion.usage.prompt_tokens || 0;
      const outputTokens = completion.usage.completion_tokens || 0;
      const totalTokens = completion.usage.total_tokens || inputTokens + outputTokens;

      const INPUT_RATE_PER_MILLION = 0.15;
      const OUTPUT_RATE_PER_MILLION = 0.60;

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

    // 7. Parse, Save to Database, and Return
    const parsedResponse = JSON.parse(completion.choices[0].message.content);
    console.log(`in /make-test : successfully generated ${parsedResponse.questions.length} questions.`);

    // Remove any previous abandoned pending tests for this user/subject to avoid conflicts
    await Test.deleteMany({ user: user._id, subject: subject.trim(), status: 'pending' });

    // Save the new test to the database
    const newTest = new Test({
      user: user._id,
      subject: subject.trim(),
      status: 'pending',
      questions: parsedResponse.questions
    });
    await newTest.save();

    return res.status(200).json({
      success: "true",
      test_id: newTest._id,
      questions: parsedResponse.questions,
    });

  } catch (error) {
    console.error("in /make-test : CRITICAL ERROR:", error);
    return res.status(500).json({
      success: "false",
      error: "Failed to generate test. Internal server error.",
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

    // --- SAFETY CHECK ---
    if (user.test_pending !== true) {
      console.log("in /submit-test : safety check failed - test_pending is false");
      return res.status(403).json({ 
        success: "false", 
        error: "No test is pending for this user." 
      });
    }

    const workspace = await Workspace.findOne({ owner: user._id, subject: subject.trim() });
    if (!workspace) {
      return res.status(404).json({ success: "false", error: "Workspace not found" });
    }

    // FETCH THE PENDING TEST FROM DB
    const pendingTest = await Test.findOne({ user: user._id, subject: subject.trim(), status: 'pending' });
    if (!pendingTest) {
      return res.status(404).json({ success: "false", error: "No pending test found to submit." });
    }

    // 3. Extract exact active subtopics (since user.currentTopics stores subtopic names)
    const activeSubtopics = user.currentTopics ? user.currentTopics.map((m) => m.topic) : [];
    
    // Prepare inputs for AI
    const userSubmissionsData = JSON.stringify(submissions, null, 2);

    const systemPrompt = `You are an objective, strict academic grading engine. Your task is to evaluate the student's test answers against academic standards and assign a retention status (color) and actionable remarks for each evaluated subtopic.

### CALIBRATION BENCHMARKS FOR RETENTION:
- "green": Good to Best performance. Flawless, conceptually solid, covers all critical nuances and correct terminology.
- "yellow": Satisfactory to Good. Understands the main idea, but misses a key step, formula detail, or secondary condition.
- "red": Poor performance. Displays partial understanding, fundamentally flawed reasoning, omits core components, or is completely incorrect/blank.

### GRADING PROTOCOL:
1. Analyze each question and answer step-by-step.
2. Determine the retention color ("red", "yellow", or "green") based on the benchmarks.
3. Write actionable "remarks" explaining exactly what the student got right, what was incorrect, and how they need to improve this specific subtopic.
4. Output the exact "subtopic_name" STRICTLY chosen from the ALLOWED SUBTOPICS list provided. Do NOT invent or alter names.
5. Return ONLY a valid JSON object matching the strict schema.`;

    // 4. Call OpenAI (gpt-4o-mini) with Structured Outputs
    console.log("in /submit-test : sending request to OpenAI (gpt-4o-mini) for grading...");
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
                description: "List of evaluated subtopics with retention status and remarks.",
                items: {
                  type: "object",
                  properties: {
                    subtopic_name: { 
                      type: "string", 
                      description: "The exact name of the subtopic from the allowed list." 
                    },
                    remarks: {
                      type: "string",
                      description: "Statement explaining what needs improvement and how."
                    },
                    retention: { 
                      type: "string", 
                      enum: ["red", "yellow", "green"],
                      description: "The evaluated retention status (red, yellow, or green)." 
                    }
                  },
                  required: ["subtopic_name", "remarks", "retention"],
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
        { role: "user", content: `ALLOWED SUBTOPICS (Use ONLY these exact names):\n${JSON.stringify(activeSubtopics)}\n\nStudent Submissions:\n${userSubmissionsData}` }
      ]
    });

    // 5. Token & Cost Logging
    if (completion.usage) {
      const inputTokens = completion.usage.prompt_tokens || 0;
      const outputTokens = completion.usage.completion_tokens || 0;
      const totalTokens = completion.usage.total_tokens || (inputTokens + outputTokens);

      const INPUT_RATE_PER_MILLION = 0.15;
      const OUTPUT_RATE_PER_MILLION = 0.60;

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

    // 6. Parse AI Response
    const parsedResponse = JSON.parse(completion.choices[0].message.content);
    const updates = parsedResponse.updated_subtopics || [];
    
    console.log(`in /submit-test : AI evaluated ${updates.length} subtopics.`);

    // 7. Update MongoDB Workspace Document Manually
    if (updates.length > 0) {
      console.log("in /submit-test : manually scanning workspace to update subtopic retention status...");
      
      let isModified = false;

      updates.forEach((update) => {
        // Robust Matching: Trim and lowercase to prevent minor string mismatches
        const targetSubtopic = update.subtopic_name.trim().toLowerCase();

        // Iterate through all parent topics in the workspace
        for (const topicDoc of workspace.detailedTopics) {
          if (Array.isArray(topicDoc.subtopics)) {
            // Check if the subtopic exists under this parent topic
            const subtopicDoc = topicDoc.subtopics.find(
              st => st.name.trim().toLowerCase() === targetSubtopic
            );
            
            if (subtopicDoc) {
              // Found it! Apply the updates
              subtopicDoc.retention = update.retention;
              subtopicDoc.remarks = update.remarks;
              subtopicDoc.last_learned_at = new Date();
              isModified = true;
              
              // Break out of the inner loop since we found and updated the target subtopic
              break; 
            }
          }
        }
      });

      // Save the document if changes were made
      if (isModified) {
        workspace.markModified('detailedTopics'); // Explicitly tell mongoose the nested array changed
        await workspace.save();
        console.log("in /submit-test : workspace scores successfully updated and saved.");
      } else {
        console.log("in /submit-test : no matching subtopics found in the workspace to update.");
      }
    }


    // 7.5 Update and save the actual Test document
    if (updates.length > 0) {
      console.log("in /submit-test : saving user answers and AI evaluations to Test document...");
      
      // Format submissions to match answerSchema
      pendingTest.answers = submissions.map(sub => ({
        question_id: sub.question_id,
        answer_text: sub.answer || ""
      }));

      // Format AI updates to match evaluationSchema
      pendingTest.evaluations = updates.map(up => ({
        subtopic_name: up.subtopic_name,
        remarks: up.remarks,
        retention: up.retention
      }));

      // Mark test as graded
      pendingTest.status = 'graded';
      await pendingTest.save();
      console.log("in /submit-test : Test document saved successfully.");
    }

    // 8. Clear the pending test flag from the user
    user.test_pending = false;
    user.currentTopics = [];
    await user.save();

    // 9. Return Response
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