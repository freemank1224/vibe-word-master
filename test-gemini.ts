
import { GoogleGenAI } from "@google/genai";

async function testConnection() {
  const apiKey = "DUMMY_KEY"; // Just to test syntax/compilation
  
  try {
    const ai = new GoogleGenAI({ apiKey: apiKey });
    console.log("SDK Structure Check:");
    console.log("ai.models exists:", !!ai.models);
    console.log("ai.models.generateContent exists:", !!ai.models?.generateContent);
    
    // Test if we can at least reach the models listing or similar if we had a key
    console.log("\nAttempting to call gemini-1.5-flash with dummy key...");
    const response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: [{ parts: [{ text: "Hi" }] }]
    });
  } catch (error: any) {
    console.log("\nCaught Expected/Actual Error:", error.message || error);
  }
}

testConnection();
