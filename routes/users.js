const express = require('express');
const router = express.Router();
const { getAuth } = require('firebase-admin/auth');
const User = require('../models/User'); // Make sure your User model is here
const verifyLogin = require("../middlewares/verifyLogin");

// POST route: /verify
router.post('/verify', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: "No token provided" });
  }

  try {
    // 1. Verify the token using the modern modular syntax
    const decodedToken = await getAuth().verifyIdToken(token);
    
    // Extract data from the Firebase token
    const { uid, email, name, picture } = decodedToken;
    console.log(`✅ Firebase User Verified: ${email}`);

    // 2. Save or Update the user in MongoDB
    // upsert: true means "insert if not found, update if found"
    const user = await User.findOneAndUpdate(
      { uid: uid }, 
      { 
        email: email, 
        displayName: name || "", 
        photoURL: picture || "" 
      },
      { new: true, upsert: true }
    );

    // 3. Send success response back to React
    return res.status(200).json({ 
      success: true, 
      user: {
        id: user._id,
        uid: user.uid,
        email: user.email
      } 
    });

  } catch (error) {
    console.error("❌ Auth/DB Error:", error.message);
    return res.status(401).json({ error: "Unauthorized. Invalid token or DB error." });
  }
});



// POST /settings/update - Save new settings
router.post('/settings', verifyLogin, async (req, res) => {
  try {

    const {uid} = req;
    
    // 3. Fetch User & Verify Chat Lock
       const user = await User.findOne({ uid });
       if (!user) return res.status(400).json({ success: "false", error: "User does not exist." });
   

    const { learnerType, preferredLanguage, fieldOfStudy, answerStructure, theme } = req.body;


    // Defensively ensure settings object exists before updating
    if (!user.settings) {
      user.settings = {};
    }

    // Update only the provided fields
    if (learnerType) user.settings.learnerType = learnerType;
    if (preferredLanguage !== undefined) user.settings.preferredLanguage = preferredLanguage; // Allow empty string for deselection
    if (fieldOfStudy) user.settings.fieldOfStudy = fieldOfStudy;
    if (answerStructure) user.settings.answerStructure = answerStructure;
    if (theme) user.settings.theme = theme;

    await user.save();

    return res.status(200).json({ 
      success: true, 
      message: 'Settings updated successfully.',
      settings: user.settings
    });

  } catch (error) {
    console.error("Error updating settings:", error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;