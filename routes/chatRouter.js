require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");
const PastPaper = require("../models/PastPaper");
const Chat = require("../models/Chat");
const verifyLogin = require("../middlewares/verifyLogin");
const User = require("../models/User");
const Workspace = require("../models/Workspace");
const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


// --- Cost Calculation Helper ---
const MODEL_PRICING = {
  "gpt-4o-mini": { inputRate: 0.15, outputRate: 0.60 },
  "gpt-5.6-luna": { inputRate: 0.20, outputRate: 1.20 },
  "gpt-5.6-terra": { inputRate: 2.00, outputRate: 12.00 },
};

function logTokenUsageAndCost(modelName, completionObj, contextLabel) {
  if (!completionObj.usage) return;
  const inputTokens = completionObj.usage.prompt_tokens || 0;
  const outputTokens = completionObj.usage.completion_tokens || 0;
  const totalTokens = completionObj.usage.total_tokens || (inputTokens + outputTokens);

  const rates = MODEL_PRICING[modelName] || { inputRate: 0, outputRate: 0 };
  const estimatedInputCost = (inputTokens / 1_000_000) * rates.inputRate;
  const estimatedOutputCost = (outputTokens / 1_000_000) * rates.outputRate;
  const totalCost = (estimatedInputCost + estimatedOutputCost).toFixed(6);

  console.log(`in /chat [${contextLabel}] : --- USAGE SUMMARY (${modelName}) ---`);
  console.log(`in /chat [${contextLabel}] : Input Tokens:  ${inputTokens} (@ $${rates.inputRate}/M)`);
  console.log(`in /chat [${contextLabel}] : Output Tokens: ${outputTokens} (@ $${rates.outputRate}/M)`);
  console.log(`in /chat [${contextLabel}] : Total Tokens:  ${totalTokens}`);
  console.log(`in /chat [${contextLabel}] : Estimated Cost: $${totalCost} USD`);
  console.log(`in /chat [${contextLabel}] : -----------------------------------`);
}

// 2. Your new Groq Client (isolated with its own API Key and Server URL)
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1", // <-- required
});




// Ensure Groq is initialized at the top of your file
// const { OpenAI } = require("openai");
// const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });

async function rollingSummary(workspace, openAiMessages) {
  try {
    // 1. Defensively initialize the summary object if it doesn't exist
    if (!workspace.currentFocusSummary) {
      workspace.currentFocusSummary = { text: "", counter: 0 };
    }

    // 2. Since openAiMessages is ALWAYS the last 3 messages, just filter the system prompt
    const conversationHistory = openAiMessages
      .filter(msg => msg.role !== "system")
      .map(msg => `${msg.role === "user" ? "Student" : "Tutor"}: ${msg.content}`)
      .join("\n\n");

    // 3. System prompt for dense, single-paragraph compression
    const summarizerSystemPrompt = `You are an expert educational tracking system. Your task is to maintain an ULTRA-CONCISE, running ledger of topics the student has covered.

CRITICAL RULES:
1. EXTREME ABSTRACTION: Do NOT explain or define the concepts. Abstract granular details into high-level category names. (e.g., instead of "Apperception theory explains how new information is integrated...", output "Apperception theory & integration").
2. STRICT LENGTH LIMIT: The entire summary MUST NEVER exceed 40 words, no matter how many chats have occurred.
3. PRUNE & MERGE: Seamlessly group new topics from the Recent Conversation into the Previous Summary. Merge related ideas and boldly delete outdated nuances to stay under the word limit.
4. FORMAT: Output a maximum of 2 to 3 short sentences. Start directly with the concepts. No introductory fluff.`;

    const summarizerUserPrompt = `PREVIOUS SUMMARY:
${workspace.currentFocusSummary.text || "No previous topics recorded."}

RECENT CONVERSATION:
${conversationHistory}`;

    // 4. API Call
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: summarizerSystemPrompt },
        { role: "user", content: summarizerUserPrompt }
      ],
      temperature: 0.2, // Low temp for structured, non-hallucinated compression
    });

    // 5. Update the text on the user object
    workspace.currentFocusSummary.text = response.choices[0].message.content.trim();

    // Note: Do NOT increment user.currentFocusSummary.counter here. 
    // That should be done in your main chat route to accurately track total turns!

    // --- USAGE & COST TRACKING ---
    const { prompt_tokens, completion_tokens, total_tokens } = response.usage;

    // Groq openai/gpt-oss-20b Pricing (per 1 Million tokens)
    const COST_PER_1M_INPUT = 0.075;
    const COST_PER_1M_OUTPUT = 0.30;

    const inputCost = (prompt_tokens / 1000000) * COST_PER_1M_INPUT;
    const outputCost = (completion_tokens / 1000000) * COST_PER_1M_OUTPUT;
    const totalCost = inputCost + outputCost;

    // 6. Log results
    console.log("\n--- Rolling Summary Updated ---");
    console.log(workspace.currentFocusSummary.text);

    console.log("\n--- Usage & Cost Report ---");
    console.log(`Input Tokens: ${prompt_tokens} | Output Tokens: ${completion_tokens} | Total: ${total_tokens}`);
    console.log(`Estimated Cost: $${totalCost.toFixed(6)}`);

  } catch (error) {
    console.error("Error generating rolling summary:", error);
  }
}



router.post("/chat", verifyLogin, async (req, res) => {
  try {
    console.log("in /chat : route hit, starting hybrid RAG chat processing...");

    const { uid } = req;
    const { selectedModel, subject, query } = req.body;


    // 1. Model mapping dictionary
    const MODEL_MAPPING = {
      astra: "gpt-4o-mini",
      stella: "gpt-5.6-luna",
      cosmos: "gpt-5.6-terra",
    };

    const normalizedModel = selectedModel?.trim().toLowerCase();
    if (!normalizedModel || !MODEL_MAPPING[normalizedModel]) {
      return res.status(400).json({
        success: "false",
        error: `Invalid model selected: '${selectedModel}'. Allowed models are Astra, Stella, or Cosmos.`,
      });
    }

    const targetModel = MODEL_MAPPING[normalizedModel];

    // 2. Input Validation
    if (!query || !query.trim()) {
      return res.status(400).json({ success: "false", error: "The 'query' field is required." });
    }
    if (!subject || !subject.trim()) {
      return res.status(400).json({ success: "false", error: "The 'subject' field is required." });
    }

    // 3. Fetch User & Verify Chat Lock
    const user = await User.findOne({ uid });
    if (!user) return res.status(400).json({ success: "false", error: "User does not exist." });


    // 4. Fetch Workspace
    const workspace = await Workspace.findOne({ owner: user._id, subject: subject.trim() });
    if (!workspace) return res.status(404).json({ success: "false", error: "Workspace not found." });

    const topicNamesList = workspace.detailedTopics.map(t => t.topic).join(", ");

    let currentFocus = workspace.currentFocus || [];

    if (workspace.test_pending) {
      return res.status(403).json({
        success: "false",
        // Add the markdown link here as well!
        answer: `**Take Test Now, The chat is freezed till then.**\n\n[👉 Click here to start the test](/takeTest?subject=${encodeURIComponent(subject.trim())})`,
        "current-topics": currentFocus,
        test_pending: true,
        chat_locked: user.chatLock || false
      });
    }

    // Log the received topics
    console.log(`in /chat : Received current-Focus from memory :`, JSON.stringify(currentFocus));

    // 5. FIRST-TIME SESSION CHECK: Pick initial subtopics using gpt-4o-mini
    if (!Array.isArray(currentFocus) || currentFocus.length === 0) {
      console.log("in /chat : Initializing new session topics via gpt-4o-mini...");

      //const currentDateISO = new Date().toISOString();
      // 1. Calculate overdue intervals in JavaScript (100% reliable)
      const now = new Date();
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;

      const categorizedSubtopics = [];

      workspace.detailedTopics.forEach((parent) => {
        if (!Array.isArray(parent.subtopics)) return;

        parent.subtopics.forEach((st) => {
          let isOverdue = false;
          let daysSinceLast = null;

          if (st.last_learned_at) {
            const lastLearned = new Date(st.last_learned_at);
            daysSinceLast = (now - lastLearned) / ONE_DAY_MS;

            // Check spaced-repetition intervals
            if (st.retention === 'red' && daysSinceLast >= 1) isOverdue = true;
            else if (st.retention === 'yellow' && daysSinceLast >= 3) isOverdue = true;
            else if (st.retention === 'green' && daysSinceLast >= 7) isOverdue = true;
          } else {
            // Untested topics are always eligible
            isOverdue = true;
          }

          // STRICT FILTER: If studied today / not overdue, exclude from the pick candidate pool
          if (isOverdue) {
            categorizedSubtopics.push({
              topic: parent.topic,
              subtopic: st.name,
              retention: st.retention,
              importance_score: parent.importance_score || 0,
              total_marks: parent.total_marks || 0,
              days_since_last_learned: daysSinceLast !== null ? Number(daysSinceLast.toFixed(1)) : 'never',
            });
          }
        });
      });

      const topicPickerResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "initial_topic_selection",
            strict: true,
            schema: {
              type: "object",
              properties: {
                selected_subtopics: {
                  type: "array",
                  items: { type: "string" },
                  description: "2 or 3 exact subtopic names chosen to study in this session."
                },
                selection_rationale: {
                  type: "string",
                  description: "Brief reason explaining why these subtopics were selected based on retention intervals or syllabus priority."
                }
              },
              required: ["selected_subtopics", "selection_rationale"],
              additionalProperties: false
            }
          }
        },
        messages: [
          {
            role: "system",
            content: `You are an academic curriculum scheduler.
Select exactly 2 to 3 subtopics for today's study session from the ELIGIBLE candidates provided.

### SELECTION PRIORITY RULES:
1. First priority: Subtopics with retention: 'red'.
2. Second priority: Subtopics with retention: 'yellow'.
3. Third priority: Subtopics with retention: 'green'.
4. Fourth priority: Subtopics with retention: 'untested' (favoring those with highest total_marks and importance_score).
5. Tie-breaker: Pick items with the highest total_marks / importance_score.

CRITICAL: Return ONLY exact subtopic names present in the provided list.`
          },
          {
            role: "user",
            content: `Eligible Candidate Subtopics:\n${JSON.stringify(categorizedSubtopics, null, 2)}`,
          },
        ]
      });

      // Log Token Usage for Topic Picker
      logTokenUsageAndCost("gpt-4o-mini", topicPickerResponse, "Initial Topic Picker");

      const pickerData = JSON.parse(topicPickerResponse.choices[0].message.content);
      console.log("in /chat : Topics selected:", pickerData.selected_subtopics, "| Rationale:", pickerData.selection_rationale);

      // To this:
      currentFocus = pickerData.selected_subtopics.map(name => ({
        topic: name, // ✅ CORRECT (Matches your Mongoose schema)
        counter: 0
      }));
    }


    // 6. Generate Embedding for User Query
    console.log("in /chat : generating embeddings for user query...");
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query.trim(),
      dimensions: 1536,
    });
    const queryVector = embeddingResponse.data[0].embedding;

    // 7. LONG-TERM MEMORY: Atlas Vector Search
    console.log("in /chat : searching long-term memory (Atlas Vector Search)...");
    const vectorSearchPipeline = [
      {
        $vectorSearch: {
          index: "chats_knowLiq",
          path: "embeddings",
          queryVector: queryVector,
          numCandidates: 50,
          limit: 2,
          filter: {
            $and: [
              { user: user._id },
              { subject: subject.trim() }
            ]
          }
        }
      },
      {
        $project: { query: 1, answer: 1, score: { $meta: "vectorSearchScore" } }
      }
    ];

    const ragResults = await Chat.aggregate(vectorSearchPipeline);
    const longTermContext = ragResults.length > 0
      ? ragResults.map(chat => `Past Question: ${chat.query}\nPast Answer: ${chat.answer}`).join("\n\n")
      : "No highly relevant past conversations found.";

    // 8. Prepare Active State String
    // When preparing prompt string:
    const activeSessionTopicsString = currentFocus
      .map(t => `${t.topic} (Turns spent: ${t.counter})`)
      .join(", ");


    // Inject the rolling summary here
    const rollingSummaryText = workspace.currentFocusSummary?.text || "No concepts taught recently.";


    // --- DYNAMIC USER SETTINGS EXTRACTION ---
    const learnerType = user.settings?.learnerType || "visual";
    const answerStructure = user.settings?.answerStructure || "normal";
    const preferredLang = user.settings?.preferredLanguage || "English";

    // 1. Determine Learning Style Instruction
    let learningStyleInstruction = "";

    if (learnerType === "visual") {
      learningStyleInstruction = `**LEARNING STYLE: VISUAL & ANALOGY MODE**
You are a visual-concept tutor. When explaining an abstract, difficult, or invisible concept, first make it mentally tangible by connecting it to a simple, concrete representation, intuitive analogy, spatial relationship, process, or familiar real-world mechanism when this genuinely improves understanding.

The analogy must be selected dynamically based on the concept being taught. Do not repeatedly use the same analogy, domain, object, or scenario. Do not force an analogy when the technical concept is already intuitive or when an analogy would introduce unnecessary complexity.

After establishing intuition, connect the analogy explicitly back to the actual technical concept, terminology, mechanism, and rules. The analogy is a temporary mental model, not a replacement for the technically accurate explanation.

Prioritize conceptual clarity over decorative examples. Use diagrams, spatial descriptions, step-by-step mental visualization, or cause-and-effect relationships when they are more appropriate than an analogy.`;

    } else if (learnerType === "socratic") {
      learningStyleInstruction = `**LEARNING STYLE: INTERACTIVE SOCRATIC MODE**
You are an Interactive Socratic Tutor. Guide the learner toward understanding through carefully selected conceptual questions rather than immediately providing the complete answer.

Keep explanations concise and reveal information progressively. Ask only one meaningful question at a time, and make each question directly relevant to the learner's current level of understanding.

End every response with exactly one targeted conceptual question based on what was just discussed. Wait for the user's answer before progressing further.`;

    } else if (learnerType === "concise") {
      learningStyleInstruction = `**LEARNING STYLE: TO-THE-POINT MODE**
You are a Strict, Concise Technical Tutor. Eliminate conversational filler and unnecessary explanation.

Present only the information required to understand the current concept. Prefer short statements, bullet points, and precise terminology over long paragraphs. Use bolding selectively for important terms.

Keep the entire response strictly under 150 words unless additional detail is absolutely necessary to prevent misunderstanding.`;
    }

    // 2. Determine Structure Instruction
    const structureInstruction = answerStructure === "detailed"
      ? "Provide comprehensive, detailed, and in-depth breakdowns."
      : "Keep explanations normal and efficient. Do not over-explain. (Cost-saving mode).";


    // --- DYNAMIC SYSTEM PROMPT ---
    const systemPrompt = `You are an elite, interactive AI tutor. Your directive is to keep the student perfectly focused using bite-sized learning and active recall.

### USER PROFILE & PREFERENCES
${learningStyleInstruction}
- **ANSWER STRUCTURE**: ${structureInstruction}
- **COMMUNICATION LANGUAGE**: Match the user's language, but your primary language is ${preferredLang}. If the language is Urdu, write exclusively in **Roman Urdu** (Urdu using the Latin/English alphabet). **Do not use Hindi** under any circumstances.

### CURRENT SESSION CONTEXT
You are currently focusing ONLY on these subtopics with the user:
[ ${activeSessionTopicsString} ]

### RECENTLY COVERED CONCEPTS (Avoid repeating these):
${rollingSummaryText}

### RELEVANT PAST KNOWLEDGE (From previous chats):
${longTermContext}

### CORE TUTORING RULES:
1. NO INFO-DUMPING: Never explain everything at once. Focus on ONLY ONE concept at a time.
2. QUESTIONING & TRANSITIONS: Do NOT ask obvious or forced questions (unless in Socratic mode). Always end your response with a clear guiding statement to smoothly transition the user to the next logical subtopic from your CURRENT SESSION CONTEXT list.
3. ADAPTABILITY: If they are confused, re-explain simply. If they master it, transition to the next logical concept.
4. FORMATTING: Use standard LaTeX for math ($$ for display, $ for inline). Keep general text formatting light. Use headings and subheadings. If a response contains multiple concepts, summarize them in a Markdown Table at the end.

### ROUTING & FLAG RULES:
- test_pending: Look at the "Turns spent" in the CURRENT SESSION CONTEXT. If ANY topic has reached 7 or more turns, you MUST immediately set "test_pending": true. DO NOT ask the user if they want to take a test. Enforce the test automatically.
- requires_global_context: If the user asks a meta-question about their overall progress, syllabus status, or historical review dates, set "requires_global_context": true.
- OFF-TOPIC HANDLING: If the user asks something entirely unrelated to the syllabus, set "tutor_response" to gently guide them back using this list of available topics: ${topicNamesList}.`;

    // 10. SHORT-TERM MEMORY: Sliding Window
    console.log("in /chat : fetching short-term memory (last 3 chats)...");
    let recentChats = await Chat.find({ user: user._id, subject: subject.trim(), success: true })
      .sort({ createdAt: -1 })
      .limit(3);
    recentChats.reverse();

    const openAiMessages = [{ role: "system", content: systemPrompt }];
    recentChats.forEach(chat => {
      if (chat.query) openAiMessages.push({ role: "user", content: chat.query });
      if (chat.answer) openAiMessages.push({ role: "assistant", content: chat.answer });
    });

    openAiMessages.push({ role: "user", content: query.trim() });

    // 11. Call Main Tutor Model with Structured Outputs
    console.log(`in /chat : sending structured payload to ${targetModel}...`);
    const completion = await openai.chat.completions.create({
      model: targetModel,
      messages: openAiMessages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "tutor_chat_response",
          strict: true,
          schema: {
            type: "object",
            properties: {
              tutor_response: {
                type: "string",
                description: "Conversational explanation, question, or guidance."
              },
              current_taught_subtopic: {
                type: ["string", "null"],
                description: "The exact name of the subtopic discussed, or null if off-topic."
              },
              test_pending: {
                type: "boolean",
                description: "Set to true if the user agreed to take a test."
              },
              requires_global_context: {
                type: "boolean",
                description: "Set to true if user asks a meta-question about syllabus or overall progress."
              }
            },
            required: [
              "tutor_response",
              "current_taught_subtopic",
              "test_pending",
              "requires_global_context"
            ],
            additionalProperties: false
          }
        }
      }
    });

    // Log Token Usage for Main Tutor Call
    logTokenUsageAndCost(targetModel, completion, "Main Tutor AI");

    let aiData = JSON.parse(completion.choices[0].message.content);
    let finalAnswer = aiData.tutor_response;



    // 11.5    
    // Defensively ensure the object exists to avoid "Cannot read properties of undefined"
    if (!workspace.currentFocusSummary) {
      workspace.currentFocusSummary = { text: "", counter: 0 };
    }

    workspace.currentFocusSummary.counter += 1;

    if (workspace.currentFocusSummary.counter % 3 === 0) {
      await rollingSummary(workspace, openAiMessages);
    }
    else {
      console.log("chats so far : ", workspace.currentFocusSummary.counter);
    }

    // 12. GLOBAL CONTEXT FALLBACK (Meta-Counselor Routing)
    if (aiData.requires_global_context) {
      console.log("in /chat : Meta inquiry detected. Routing to gpt-4o-mini with full syllabus...");

      const currentDateISO = new Date().toISOString();

      const metaCounselorResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an academic counselor and curriculum advisor.
Your job is to answer the student's meta-questions about their syllabus, learning progress, weak areas, or past study schedule.

### TODAY'S DATE:
${currentDateISO}

### SYLLABUS SCHEMA DEFINITION:
- "topic": Parent topic name.
- "importance_score" & "total_marks": Exam weight and frequency in past papers.
- "subtopics.name": Specific subtopic title.
- "subtopics.historical_score": Fluency score (0.00 to 1.00).
- "subtopics.retention": Latest test grade ('red' = weak, 'yellow' = moderate, 'green' = strong, 'untested' = brand new).
- "subtopics.last_learned_at": UTC ISO timestamp of the last time this subtopic was taught.

### INSTRUCTIONS:
1. PROGRESS & WEAKNESSES: Always answer general questions ("What should I study?", "help", "I don't know what to do") by looking at their "historical_score" and "retention" data to suggest a specific weak topic. 
2. TIME-BASED INQUIRIES: Compare "last_learned_at" against TODAY'S DATE to accurately answer questions like "what did I learn 5 days ago?".
3. GREETINGS & CHAT: If the user says hello or makes casual conversation, briefly acknowledge it but immediately pivot back to suggesting a topic from their syllabus data.
4. OFF-TOPIC HANDLING: If the user explicitly asks about entirely unrelated subjects (e.g., politics, movies, cooking), do not use a robotic error message. Instead, politely explain that you are their academic counselor and ask them which syllabus topic they want to tackle today.
5. TONE: Concise, encouraging, and clear (max 2-3 short paragraphs). Match language (English, Urdu, or Roman Urdu).`
          },
          {
            role: "user",
            content: `Full Syllabus Data:\n${JSON.stringify(workspace.detailedTopics, null, 2)}\n\nStudent Inquiry:\n${query.trim()}`
          }
        ]
      });

      // Log Token Usage for Meta-Counselor Call
      logTokenUsageAndCost("gpt-4o-mini", metaCounselorResponse, "Meta-Counselor Fallback");

      finalAnswer = metaCounselorResponse.choices[0].message.content;
    }

    // 13. MUTATE TOPIC COUNTERS & UPDATE WORKSPACE DATABASE
    if (aiData.current_taught_subtopic) {
      const taughtName = aiData.current_taught_subtopic.trim();

      const matchedIndex = currentFocus.findIndex(
        t => t.topic && t.topic.trim().toLowerCase() === taughtName.toLowerCase()
      );

      if (matchedIndex !== -1) {
        currentFocus[matchedIndex].counter = (currentFocus[matchedIndex].counter || 0) + 1;

        await Workspace.updateOne(
          {
            _id: workspace._id,
            "detailedTopics.subtopics.name": currentFocus[matchedIndex].topic
          },
          {
            $set: {
              "detailedTopics.$[].subtopics.$[sub].last_learned_at": new Date()
            }
          },
          {
            arrayFilters: [
              { "sub.name": currentFocus[matchedIndex].topic }
            ]
          }
        );
      }
    }

    // Initialize block-scoped variable outside try-catch to ensure it's accessible at the end of the route
    let isTestPending = false;

    // 14. SYNC CURRENT TOPICS & HANDLE TEST PENDING LOCK
    try {
      isTestPending = Boolean(aiData.test_pending);

      if (isTestPending) {
        console.log("in /chat : test_pending flag is true. Locking user chat...");
        workspace.test_pending = true;
        finalAnswer =`**Take Test Now, The chat is freezed till then.**\n\n[👉 Click here to start the test](/takeTest?subject=${encodeURIComponent(subject.trim())})`;
      }

      // Sync the mutated in-memory array to the user document
      workspace.currentFocus = currentFocus || [];
      workspace.markModified("currentFocus");
      workspace.markModified("currentFocusSummary"); // <--- ADD THIS LINE

      // One single save for both the chat lock and the current topics
      await workspace.save();
      await user.save();

    } catch (saveError) {
      console.error("in /chat : Failed to update User DB:", saveError.message);
    }

    // 15. SAVE INTERACTION TO CHAT COLLECTION
    try {
      const newChat = new Chat({
        user: user._id,
        subject: subject.trim(),
        query: query.trim(),
        answer: finalAnswer,
        embeddings: queryVector,
        success: true
      });
      await newChat.save();
    } catch (dbError) {
      console.error("in /chat : Failed to save chat to DB:", dbError.message);
    }


    // 16. RETURN CLEAN PAYLOAD TO FRONTEND
    return res.status(200).json({
      success: "true",
      answer: finalAnswer,
      "current-topics": currentFocus,
      test_pending: isTestPending,
      chat_locked: user.chatLock || false
    });

  } catch (error) {
    console.error("in /chat : CRITICAL ERROR:", error);
    return res.status(500).json({ success: "false", error: "Internal server error." });
  }
});




router.post("/chat-01", async (req, res) => {
  try {
    console.log("in /chat : standalone AI chat route hit...");

    const { selectedModel, query } = req.body;

    // --------------------------------------------------
    // 1. MODEL MAPPING
    // --------------------------------------------------

    const MODEL_MAPPING = {
      astra: "gpt-4o-mini",
      stella: "gpt-5.6-luna",
      cosmos: "gpt-5.6-terra",
    };

    // Normalize selected model
    const normalizedModel = selectedModel?.trim().toLowerCase();

    if (!normalizedModel || !MODEL_MAPPING[normalizedModel]) {
      return res.status(400).json({
        success: "false",
        error: `Invalid model selected: '${selectedModel}'. Allowed models are Astra, Stella, or Cosmos.`,
      });
    }

    // Resolve actual OpenAI model
    const targetModel = MODEL_MAPPING[normalizedModel];

    // --------------------------------------------------
    // 2. INPUT VALIDATION
    // --------------------------------------------------

    if (!query || !query.trim()) {
      return res.status(400).json({
        success: "false",
        error: "The 'query' field is required.",
      });
    }

    // --------------------------------------------------
    // 3. SYSTEM PROMPT
    // --------------------------------------------------

    const systemPrompt = `
You are a highly capable academic problem-solving AI.

Your primary task is to solve the user's problem accurately and rigorously.

The user may ask complex problems involving:

- Mathematics
- Calculus
- Differential equations
- Linear algebra
- Vector calculus
- 3D geometry
- Engineering mathematics
- Fluid mechanics
- CFD
- Navier-Stokes equations
- Thermodynamics
- Heat transfer
- Dynamics
- Mechanics
- Control systems
- Physics
- Engineering derivations

For mathematical and engineering problems:

1. Carefully identify the given information.
2. Identify the governing equations or principles.
3. State important assumptions.
4. Derive the solution step by step.
5. Maintain correct signs, units, coordinate systems, and boundary conditions.
6. Do not skip mathematically important steps.
7. Check the final result where appropriate.
8. If there are multiple interpretations, explicitly identify the ambiguity and state which interpretation you are using.
9. Do not fabricate information.
10. Prioritize correctness over brevity.

Formatting rule : - NEVER use the \boxed{} command in LaTeX. Just output the equations normally.

For equations, use standard LaTeX markdown.

Use $$ for display equations and $ for inline equations.

Do not unnecessarily simplify or shorten a difficult derivation.

Answer the user's actual question directly.
`;

    // --------------------------------------------------
    // 4. OPENAI MESSAGE PAYLOAD
    // --------------------------------------------------

    const openAiMessages = [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: query.trim(),
      },
    ];

    // --------------------------------------------------
    // 5. CALL OPENAI
    // --------------------------------------------------

    console.log(
      `in /chat : sending standalone request to ${targetModel}`
    );

    const completion = await openai.chat.completions.create({
      model: targetModel,
      messages: openAiMessages,
    });

    const aiAnswer = completion.choices[0].message.content;

    // --------------------------------------------------
    // 6. MODEL PRICING MAP (Per 1 Million Tokens)
    // --------------------------------------------------

    const MODEL_PRICING = {
      "gpt-4o-mini": {
        inputRate: 0.15,
        outputRate: 0.60,
      },

      "gpt-5.6-luna": {
        inputRate: 0.20,
        outputRate: 1.20,
      },

      "gpt-5.6-sol": {
        inputRate: 5.00,
        outputRate: 15.00,
      },
    };

    // --------------------------------------------------
    // 7. TOKEN USAGE & COST CALCULATION
    // --------------------------------------------------

    if (completion.usage) {
      const inputTokens = completion.usage.prompt_tokens || 0;
      const outputTokens = completion.usage.completion_tokens || 0;
      const totalTokens =
        completion.usage.total_tokens ||
        (inputTokens + outputTokens);

      // Fallback to Luna rates if model isn't mapped
      const rates =
        MODEL_PRICING[targetModel] || {
          inputRate: 0.20,
          outputRate: 1.20,
        };

      const estimatedInputCost =
        (inputTokens / 1_000_000) * rates.inputRate;

      const estimatedOutputCost =
        (outputTokens / 1_000_000) * rates.outputRate;

      const totalCost = (
        estimatedInputCost + estimatedOutputCost
      ).toFixed(6);

      console.log(
        `in /chat : --- USAGE SUMMARY (${targetModel}) ---`
      );

      console.log(
        `in /chat : Input Tokens:  ${inputTokens} (@ $${rates.inputRate}/M)`
      );

      console.log(
        `in /chat : Output Tokens: ${outputTokens} (@ $${rates.outputRate}/M)`
      );

      console.log(
        `in /chat : Total Tokens:  ${totalTokens}`
      );

      console.log(
        `in /chat : Estimated Cost: $${totalCost} USD`
      );

      console.log(
        `in /chat : -----------------------------------`
      );
    }

    // --------------------------------------------------
    // 8. RETURN RESPONSE TO FRONTEND
    // --------------------------------------------------

    return res.status(200).json({
      success: "true",
      answer: aiAnswer,
    });

  } catch (error) {
    console.error(
      "in /chat : CRITICAL ERROR:",
      error
    );

    return res.status(500).json({
      success: "false",
      error: "Internal server error.",
    });
  }
});


router.get("/fetch-chat", verifyLogin, async (req, res) => {
  try {
    const { uid } = req;

    // Use req.query for GET requests (e.g., /fetch-chat?subject=Physics)
    const { subject } = req.query;

    if (!subject) {
      return res.status(400).json({ success: "false", error: "Subject is required" });
    }

    const user = await User.findOne({ uid });

    if (!user) {
      return res.status(400).json({ success: "false", error: "User does not exist" });
    }

    // 👇 FIX: Fetch the workspace before accessing it!
    const workspace = await Workspace.findOne({ 
      owner: user._id, 
      subject: subject.trim() 
    });

    const isTestPending = workspace.test_pending || false;

    // Find chats for this user and subject, sorted from oldest to newest
    const chats = await Chat.find({
      user: user._id,
      subject: subject
    }).sort({ createdAt: 1 });

    // Convert Mongoose documents to standard JS array so we can safely modify it
    const chatData = chats.map(chat => chat.toObject());

    // If a test is pending, automatically append the "Take Test" card to the chat history
    if (isTestPending) {
      chatData.push({
        answer: `### 🛑 Chat is Freezed!\n\n**Time to prove what you've learned.** You must complete your pending evaluation to unlock this workspace.\n\n[👉 CLICK HERE TO TAKE TEST NOW](/takeTest?subject=${encodeURIComponent(subject.trim())})`
      });
    }

    return res.status(200).json({
      success: "true",
      message: "Chats retrieved successfully",
      data: chatData,
      test_pending: isTestPending, // Fixed: dynamically send actual user state, not hardcoded true
    });

  } catch (error) {
    console.error("error in /fetch-chat:", error.message);
    return res.status(500).json({
      success: "false",
      error: "Something went wrong!"
    });
  }
});

//for fetchign shared chat
router.get("/shared/:shared_workspace_id", async (req, res) => {
  try {
    const { shared_workspace_id } = req.params;

    if (!shared_workspace_id) {
      return res.status(400).json({ success: false, error: "Workspace ID is required" });
    }

    // 1. Find the workspace to get the associated owner and subject
    const workspace = await Workspace.findOne({
      _id: shared_workspace_id,
      shared: true
    });

    if (!workspace) {
      return res.status(404).json({ success: false, error: "Shared workspace not found" });
    }

    // 2. Extract the owner (user reference) and subject from the workspace
    const { owner, subject } = workspace;

    // 3. Find chats using the workspace's owner ID and subject
    const chats = await Chat.find({
      user: owner,
      subject: subject
    }).sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      message: "Shared chats retrieved successfully",
      data: chats
    });

  } catch (error) {
    console.error("error in /shared/:shared_workspace_id:", error.message);

    // Handle cases where the shared_workspace_id is not a valid MongoDB ObjectId format
    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        error: "Invalid workspace ID format"
      });
    }

    return res.status(500).json({
      success: false,
      error: "Something went wrong!"
    });
  }
});


// Assuming you are sending the workspace 'subject' in the request body 
// so the backend knows *which* workspace to share.

router.post("/create_workspace_shared", verifyLogin, async (req, res) => {
  try {
    const { uid } = req;
    const { subject } = req.body; // Needs the subject to identify the specific workspace

    if (!subject) {
      return res.status(400).json({ success: false, error: "Subject is required" });
    }

    // 1. Find the user based on uid from the verifyLogin middleware
    const user = await User.findOne({ uid });

    if (!user) {
      return res.status(400).json({ success: false, error: "User does not exist" });
    }

    // 2. Find the workspace by owner (user._id) and subject, then update/add the 'shared' field
    // $set will add the field if it doesn't exist, or update it if it does.
    // { new: true } ensures Mongoose returns the updated document.
    const workspace = await Workspace.findOneAndUpdate(
      { owner: user._id, subject: subject },
      { $set: { shared: true } },
      { new: true }
    );

    if (!workspace) {
      return res.status(404).json({ success: false, error: "Workspace not found" });
    }

    // 3. Return the workspace._id as requested
    return res.status(200).json({
      success: true,
      message: "Workspace shared successfully",
      shared_workspace_id: workspace._id
    });

  } catch (error) {
    console.error("error in /create_workspace_shared:", error.message);
    return res.status(500).json({
      success: false,
      error: "Something went wrong!"
    });
  }
});


module.exports = router;
