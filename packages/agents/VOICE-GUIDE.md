# Agent Voice Guide

Use this guide to select the right voice for your agent's personality.

## Available Voices

### alloy
**Personality:** Neutral, balanced, versatile
**Best for:** General-purpose agents, help systems, fallback responses
**Tone:** Professional but approachable
**Keywords:** neutral, balanced, default, professional, versatile

### ash
**Personality:** Warm, friendly, personable  
**Best for:** Entertainment, music, social agents, personal assistants
**Tone:** Like a friend who's genuinely happy to help
**Keywords:** warm, friendly, personable, DJ, music, entertainment, social

### ballad
**Personality:** Expressive, storytelling, dramatic
**Best for:** Creative agents, storytelling, narrative content
**Tone:** Theatrical, engaging, emotionally rich
**Keywords:** expressive, storytelling, dramatic, creative, narrative, theatrical

### coral
**Personality:** Clear, professional, articulate
**Best for:** Business agents, scheduling, formal interactions
**Tone:** Confident and clear, like a professional assistant
**Keywords:** clear, professional, articulate, business, formal, scheduling

### echo
**Personality:** Deep, authoritative, knowledgeable
**Best for:** Search agents, educational content, expert systems
**Tone:** The voice of authority and expertise
**Keywords:** authoritative, deep, knowledgeable, expert, educational, search

### sage
**Personality:** Calm, wise, measured
**Best for:** Time/date agents, spelling, precision tasks, meditation
**Tone:** Thoughtful and unhurried, instills confidence
**Keywords:** calm, wise, measured, precise, thoughtful, time, spelling

### shimmer
**Personality:** Energetic, bright, enthusiastic
**Best for:** Motivational agents, fitness, upbeat interactions
**Tone:** Positive energy that lifts the mood
**Keywords:** energetic, bright, enthusiastic, upbeat, motivational, fitness

### verse
**Personality:** Natural, conversational, relatable
**Best for:** Weather, casual chat, everyday interactions
**Tone:** Like talking to a neighbor - easy and natural
**Keywords:** natural, conversational, relatable, casual, everyday, weather

---

## Quick Reference Table

| Voice | One-Word | Best For |
|-------|----------|----------|
| alloy | Neutral | General purpose, help |
| ash | Friendly | Music, entertainment, social |
| ballad | Dramatic | Storytelling, creative |
| coral | Professional | Business, scheduling |
| echo | Authoritative | Search, education, experts |
| sage | Calm | Time, spelling, precision |
| shimmer | Energetic | Motivation, fitness |
| verse | Natural | Weather, casual chat |

---

## Setting Voice in Agent Definition

Add the `voice` property to your agent:

```javascript
const myAgent = {
  id: 'my-agent',
  name: 'My Agent',
  voice: 'ash',  // Choose from: alloy, ash, ballad, coral, echo, sage, shimmer, verse
  // ... other properties
};
```

## Default Voice Assignments

| Agent | Voice | Reason |
|-------|-------|--------|
| dj-agent | ash | Warm and friendly like a radio DJ |
| smalltalk-agent | coral | Clear and welcoming for greetings |
| time-agent | sage | Calm and precise for time info |
| weather-agent | verse | Natural and conversational |
| calendar-agent | coral | Professional for scheduling |
| help-agent | alloy | Neutral and helpful |
| search-agent | echo | Authoritative for information |
| spelling-agent | sage | Calm and precise for accuracy |
