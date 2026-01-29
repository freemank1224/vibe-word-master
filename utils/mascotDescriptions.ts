export const MASCOT_DESCRIPTIONS: Record<number, string> = {
  0: "A cute, round, red-orange warm monster tailored for Sunday, embodying relaxation and sun warmth. It has soft fur and a friendly smile.",
  1: "A small, energetic, electric-blue monster for Monday, symbolizing a fresh start and energy. It has lightning-bolt shaped antennae.",
  2: "A focused, green-leaf patterned monster for Tuesday, representing growth and steady progress. It wears glasses and looks smart.",
  3: "A cheerful, yellow bubble-like monster for Wednesday, representing the peak of the week. It is floating and glowing softly.",
  4: "A calm, reliable, purple monster for Thursday, symbolizing wisdom and anticipation. It has a magical aura.",
  5: "A fun-loving, pink, party-ready monster for Friday, representing excitement for the weekend. It has confetti-like spots.",
  6: "A partially lazy, sloth-like turquoise monster for Saturday, representing leisure and play. It is holding a pillow or toy."
};

export const getMascotPrompt = (dayIndex: number, word: string): string => {
  const mascotDesc = MASCOT_DESCRIPTIONS[dayIndex] || MASCOT_DESCRIPTIONS[0];
  
  return `A square (1:1 aspect ratio) 512x512 thumbnail illustration. 
  Subject: ${mascotDesc}
  Action: The mascot is interacting with or demonstrating the concept of the English word: "${word}".
  Style: High-quality 3D rendered character design, cute, vibrant lighting, minimal clean background. 
  Constraint: No text, no letters, no complex details. The focus must be on the monster and the object/action representing "${word}".`;
};
