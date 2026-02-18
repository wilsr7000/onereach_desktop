/**
 * Filter Prompts for Generative Search
 *
 * Each filter type has a specific prompt template that instructs the LLM
 * how to evaluate items against that criterion.
 */

/**
 * Individual filter prompt definitions
 */
const FILTER_PROMPTS = {
  // Context-Aware Filters
  related_to_project: {
    name: 'Related to Project',
    systemPrompt: `Evaluate how relevant each item is to the project context.
Consider: Does this item directly support the project goals? Could it be useful for the project? Is it on-topic?
Score 0-100 where:
- 90-100: Directly relevant, core to the project
- 70-89: Strongly related, useful for the project
- 50-69: Somewhat related, might be useful
- 30-49: Tangentially related
- 0-29: Not related to the project`,
    buildPrompt: (context) => {
      if (!context.spaceContext) {
        return 'Evaluate general relevance and usefulness.';
      }
      return `PROJECT CONTEXT:
Name: ${context.spaceContext.name}
${context.spaceContext.purpose ? `Purpose: ${context.spaceContext.purpose}` : ''}
${context.spaceContext.description ? `Description: ${context.spaceContext.description}` : ''}
${context.spaceContext.tags?.length > 0 ? `Tags: ${context.spaceContext.tags.join(', ')}` : ''}

Evaluate how relevant each item is to this project.`;
    },
  },

  similar_to_item: {
    name: 'Similar to Selected',
    systemPrompt: `Evaluate semantic similarity to the reference item.
Consider: Similar topic? Similar format? Similar purpose? Complementary content?
Score 0-100 where:
- 90-100: Nearly identical topic/purpose
- 70-89: Very similar, closely related
- 50-69: Moderately similar
- 30-49: Some similarity
- 0-29: Not similar`,
    buildPrompt: (context) => {
      if (!context.referenceItem) {
        return 'Evaluate general similarity between items.';
      }
      const ref = context.referenceItem;
      return `REFERENCE ITEM:
Type: ${ref.type}
${ref.title ? `Title: ${ref.title}` : ''}
${ref.preview ? `Preview: ${ref.preview.substring(0, 300)}` : ''}
${ref.tags?.length > 0 ? `Tags: ${ref.tags.join(', ')}` : ''}

Evaluate how similar each item is to this reference.`;
    },
  },

  useful_for: {
    name: 'Useful For',
    systemPrompt: `Evaluate how useful each item would be for the stated goal.
Consider: Does it directly help? Does it provide information needed? Is it a resource that could be used?
Score 0-100 where:
- 90-100: Extremely useful, directly addresses the need
- 70-89: Very useful, highly relevant
- 50-69: Moderately useful
- 30-49: Slightly useful
- 0-29: Not useful for this purpose`,
    buildPrompt: (context) => {
      const goal = context.filterInputs?.useful_for || context.userQuery || 'general productivity';
      return `USER'S GOAL: ${goal}

Evaluate how useful each item would be for achieving this goal.`;
    },
  },

  // Quality/Time Filters
  quality_score: {
    name: 'Quality Score',
    systemPrompt: `Evaluate the quality, polish, and craftsmanship of each item.
Consider: Is it complete? Well-organized? Professional? Clear and understandable?
Score 0-100 where:
- 90-100: Exceptional quality, polished and professional
- 70-89: High quality, well-crafted
- 50-69: Good quality, serviceable
- 30-49: Below average quality
- 0-29: Poor quality, incomplete or messy`,
    buildPrompt: () => `Evaluate the quality, completeness, and craftsmanship of each item.`,
  },

  interesting_novel: {
    name: 'Interesting/Novel',
    systemPrompt: `Evaluate how interesting, unique, or creative each item is.
Consider: Is it innovative? Does it present a fresh perspective? Is it memorable?
Score 0-100 where:
- 90-100: Highly innovative, truly unique
- 70-89: Very interesting, creative approach
- 50-69: Somewhat interesting
- 30-49: Fairly common/standard
- 0-29: Very common, nothing novel`,
    buildPrompt: () => `Evaluate how interesting, unique, and creative each item is.`,
  },

  recent_favorites: {
    name: 'Recent Favorites',
    systemPrompt: `Identify items that appear to be high-quality recent work worth revisiting.
Consider: Quality + apparent importance + completeness + usefulness.
Score 0-100 where:
- 90-100: Standout item, definitely worth revisiting
- 70-89: Strong candidate, notable work
- 50-69: Good item, might be worth another look
- 30-49: Average, probably not a priority
- 0-29: Low priority for revisiting`,
    buildPrompt: () =>
      `Identify items that appear to be valuable recent work worth revisiting. Consider quality, completeness, and apparent importance.`,
  },

  // Purpose-Based Filters
  good_visual_for: {
    name: 'Good Visual For',
    systemPrompt: `Evaluate how well each visual item (image, video, screenshot) fits the specified use case.
Consider: Does the visual convey the right message? Is it the right style? High enough quality?
Score 0-100 where:
- 90-100: Perfect visual for this use
- 70-89: Very good fit
- 50-69: Could work
- 30-49: Not ideal but possible
- 0-29: Not suitable
For non-visual items, score based on whether they contain or reference relevant visuals.`,
    buildPrompt: (context) => {
      const useCase = context.filterInputs?.good_visual_for || 'a presentation';
      return `VISUAL NEEDED FOR: ${useCase}

Evaluate how well each item would work as a visual for this purpose.`;
    },
  },

  reference_material: {
    name: 'Reference Material',
    systemPrompt: `Evaluate whether each item serves as good reference or learning material.
Consider: Does it teach something? Is it authoritative? Can it be consulted repeatedly?
Score 0-100 where:
- 90-100: Excellent reference, comprehensive and authoritative
- 70-89: Very good reference material
- 50-69: Useful reference
- 30-49: Limited reference value
- 0-29: Not useful as reference`,
    buildPrompt: () => `Evaluate which items serve as good reference or learning material.`,
  },

  working_example: {
    name: 'Working Example Of',
    systemPrompt: `Evaluate whether each item is a working example or demonstration of the specified pattern/technique.
Consider: Does it actually demonstrate the thing? Is it functional? Is it a good example to learn from?
Score 0-100 where:
- 90-100: Perfect example, clear demonstration
- 70-89: Very good example
- 50-69: Decent example
- 30-49: Partial example
- 0-29: Not an example of this`,
    buildPrompt: (context) => {
      const pattern = context.filterInputs?.working_example || 'a coding pattern';
      return `LOOKING FOR EXAMPLES OF: ${pattern}

Evaluate which items are working examples or demonstrations of this.`;
    },
  },

  inspiration_for: {
    name: 'Inspiration For',
    systemPrompt: `Evaluate how inspiring or useful as a creative starting point each item would be.
Consider: Does it spark ideas? Can it be adapted? Does it show what's possible?
Score 0-100 where:
- 90-100: Highly inspiring, great starting point
- 70-89: Very inspiring
- 50-69: Somewhat inspiring
- 30-49: Mildly inspiring
- 0-29: Not inspiring for this purpose`,
    buildPrompt: (context) => {
      const creative = context.filterInputs?.inspiration_for || 'a creative project';
      return `INSPIRATION NEEDED FOR: ${creative}

Evaluate which items could serve as inspiration or creative starting points.`;
    },
  },

  // Content Analysis Filters
  actionable_insights: {
    name: 'Has Actionable Insights',
    systemPrompt: `Evaluate whether each item contains actionable insights - things that can be directly acted upon.
Consider: Does it provide steps to take? Recommendations? Decisions to make? Tasks to do?
Score 0-100 where:
- 90-100: Full of actionable insights
- 70-89: Several good action items
- 50-69: Some actionable content
- 30-49: Limited actionability
- 0-29: No actionable insights`,
    buildPrompt: () =>
      `Evaluate which items contain actionable insights - things that can be directly acted upon or implemented.`,
  },

  contains_data_about: {
    name: 'Contains Data About',
    systemPrompt: `Evaluate whether each item contains relevant data, statistics, or information about the specified topic.
Consider: Does it have numbers? Facts? Research? Evidence?
Score 0-100 where:
- 90-100: Rich with relevant data
- 70-89: Good amount of data
- 50-69: Some data present
- 30-49: Limited data
- 0-29: No relevant data`,
    buildPrompt: (context) => {
      const topic = context.filterInputs?.contains_data_about || 'the topic';
      return `LOOKING FOR DATA ABOUT: ${topic}

Evaluate which items contain data, statistics, or factual information about this topic.`;
    },
  },

  explains_concept: {
    name: 'Explains Concept',
    systemPrompt: `Evaluate how well each item explains or teaches the specified concept.
Consider: Is the explanation clear? Comprehensive? Accurate? Easy to understand?
Score 0-100 where:
- 90-100: Excellent explanation, comprehensive
- 70-89: Very good explanation
- 50-69: Decent explanation
- 30-49: Partial or unclear explanation
- 0-29: Doesn't explain this concept`,
    buildPrompt: (context) => {
      const concept = context.filterInputs?.explains_concept || 'the concept';
      return `LOOKING FOR EXPLANATIONS OF: ${concept}

Evaluate which items explain or teach this concept.`;
    },
  },

  // Organizational Filters
  needs_attention: {
    name: 'Needs Attention',
    systemPrompt: `Evaluate whether each item needs attention - is incomplete, outdated, or could use improvement.
Consider: Is it a draft? Missing information? Could be better organized? Needs updating?
Score 0-100 where:
- 90-100: Definitely needs attention/work
- 70-89: Should probably be addressed
- 50-69: Could use some attention
- 30-49: Minor improvements possible
- 0-29: Seems complete/fine as-is`,
    buildPrompt: () =>
      `Identify items that need attention - incomplete work, items that could use improvement, or things that should be revisited.`,
  },

  could_be_grouped: {
    name: 'Could Be Grouped With',
    systemPrompt: `Evaluate whether each item could logically be grouped with the reference item.
Consider: Same topic? Same project? Related purpose? Would make sense in the same folder?
Score 0-100 where:
- 90-100: Definitely belongs together
- 70-89: Should probably be grouped
- 50-69: Could be grouped
- 30-49: Weak connection
- 0-29: No reason to group together`,
    buildPrompt: (context) => {
      if (!context.referenceItem) {
        return 'Identify items that could logically be grouped together.';
      }
      const ref = context.referenceItem;
      return `REFERENCE ITEM:
Type: ${ref.type}
${ref.title ? `Title: ${ref.title}` : ''}
${ref.preview ? `Preview: ${ref.preview.substring(0, 200)}` : ''}

Find items that could logically be grouped with this reference item.`;
    },
  },

  duplicates_variations: {
    name: 'Duplicates/Variations',
    systemPrompt: `Identify items that appear to be duplicates or variations of each other.
Consider: Same content? Minor differences? Different versions of the same thing?
Score 0-100 where:
- 90-100: Likely duplicate or near-duplicate
- 70-89: Very similar, probably variations
- 50-69: Similar enough to review
- 30-49: Some similarity
- 0-29: Distinct items`,
    buildPrompt: () =>
      `Identify items that appear to be duplicates or variations of other items in the set. High scores indicate items that might be consolidated.`,
  },
};

/**
 * Build the complete evaluation prompt for a set of filters
 */
function buildEvaluationPrompt(filters, context = {}) {
  const filterInstructions = filters
    .map((filter) => {
      const template = FILTER_PROMPTS[filter.id];
      if (!template) {
        return `${filter.id}: Score 0-100 based on relevance.`;
      }

      const specificPrompt = template.buildPrompt({
        ...context,
        filterInputs: { [filter.id]: filter.input },
      });

      return `## ${template.name} (${filter.id})
${template.systemPrompt}

${specificPrompt}`;
    })
    .join('\n\n');

  const filterIds = filters.map((f) => f.id);

  return `You are an expert content evaluator. Evaluate each item against the specified criteria.
For each item, provide a score from 0-100 for each criterion.

EVALUATION CRITERIA:
${filterInstructions}

IMPORTANT:
- Score each item independently
- Be consistent in your scoring
- Consider all available information about each item
- For each item, provide a brief reason (1 sentence) explaining WHY you gave that score
- Return ONLY valid JSON in this format:
{"scores": [
  {"${filterIds.join('": <score>, "')}":<score>, "reason": "<brief 1-sentence explanation of why this item scored this way>"},
  ...
]}

Where each object in the array corresponds to an item in order.`;
}

/**
 * Get all available filter prompts
 */
function getAvailableFilters() {
  return Object.entries(FILTER_PROMPTS).map(([id, template]) => ({
    id,
    name: template.name,
    description: template.systemPrompt.split('\n')[0],
  }));
}

module.exports = {
  FILTER_PROMPTS,
  buildEvaluationPrompt,
  getAvailableFilters,
};
