const { getStyleGuideExtractor } = require('./style-guide-extractor');
const { getCopyStyleExtractor } = require('./copy-style-extractor');
const { getStylePromptGenerator } = require('./style-prompt-generator');
const fs = require('fs');

async function testOneReach() {
  console.log('==========================================');
  console.log('  TESTING WITH ONEREACH.AI');
  console.log('==========================================');

  const styleExtractor = getStyleGuideExtractor();
  const copyExtractor = getCopyStyleExtractor();

  try {
    // 1. Extract Visual Style Guide
    console.log('\n1. EXTRACTING VISUAL STYLE GUIDE...');
    console.log('─'.repeat(50));
    await styleExtractor.init();
    const styleData = await styleExtractor.extract('https://onereach.ai');
    const styleReport = styleExtractor.generateReport(styleData);
    const styleCssVars = styleExtractor.generateCSSVariables(styleData);
    const styleResult = { data: styleData, report: styleReport, cssVariables: styleCssVars };

    console.log('\n   TYPOGRAPHY:');
    console.log('   • Fonts:', styleResult.data.typography?.fonts?.length || 0);
    if (styleResult.data.typography?.fonts?.[0]) {
      console.log('     Primary:', styleResult.data.typography.fonts[0].full);
    }
    if (styleResult.data.typography?.body) {
      console.log('     Body:', styleResult.data.typography.body.fontSize, styleResult.data.typography.body.color);
    }
    if (styleResult.data.typography?.headings) {
      Object.entries(styleResult.data.typography.headings).forEach(([tag, style]) => {
        console.log('     ' + tag.toUpperCase() + ':', style.fontSize, style.fontWeight);
      });
    }

    console.log('\n   COLORS:');
    console.log('   • Backgrounds:', styleResult.data.colors?.backgrounds?.length || 0);
    styleResult.data.colors?.backgrounds?.slice(0, 3).forEach((c) => {
      console.log('     -', c.value, '(' + c.context + ')');
    });
    console.log('   • Text colors:', styleResult.data.colors?.text?.length || 0);
    styleResult.data.colors?.text?.slice(0, 3).forEach((c) => {
      console.log('     -', c.value);
    });
    console.log('   • Accent colors:', styleResult.data.colors?.accents?.length || 0);
    styleResult.data.colors?.accents?.slice(0, 5).forEach((c) => {
      console.log('     -', c.value, '(' + c.context + ')');
    });

    console.log('\n   BUTTONS:', styleResult.data.buttons?.length || 0);
    styleResult.data.buttons?.slice(0, 2).forEach((btn, i) => {
      console.log('     Button ' + (i + 1) + ':');
      console.log('       bg:', btn.backgroundColor);
      console.log('       text:', btn.color);
      console.log('       radius:', btn.borderRadius);
    });

    console.log('\n   CSS VARIABLES:', Object.keys(styleResult.data.cssVariables || {}).length);
    Object.entries(styleResult.data.cssVariables || {})
      .slice(0, 5)
      .forEach(([k, v]) => {
        console.log('     ', k + ':', v);
      });

    console.log('\n   SHADOWS:', styleResult.data.shadows?.length || 0);
    console.log('   BORDER RADII:', styleResult.data.borders?.radii?.length || 0);

    // 2. Extract Copy Style Guide
    console.log('\n\n2. EXTRACTING COPY STYLE GUIDE...');
    console.log('─'.repeat(50));
    await copyExtractor.init();
    const copyData = await copyExtractor.extract('https://onereach.ai');
    const copyReport = copyExtractor.generateReport(copyData);
    const voiceSummary = copyExtractor.generateVoiceSummary(copyData);
    const copyResult = { data: copyData, report: copyReport, voiceSummary: voiceSummary };

    console.log('\n   BRAND:');
    console.log('   • Name:', copyResult.data.brand?.name || 'Not found');
    console.log('   • Tagline:', (copyResult.data.brand?.tagline || 'Not found').substring(0, 80));

    console.log('\n   TONE INDICATORS:');
    Object.entries(copyResult.data.toneIndicators || {}).forEach(([tone, score]) => {
      if (score > 0) {
        const bar = '█'.repeat(Math.min(score, 20));
        console.log('   •', tone.padEnd(12), bar, score);
      }
    });

    console.log('\n   HEADLINES:');
    console.log('   • Primary (H1):', copyResult.data.headlines?.primary?.length || 0);
    copyResult.data.headlines?.primary?.slice(0, 3).forEach((h) => {
      console.log('     -', h.substring(0, 60) + (h.length > 60 ? '...' : ''));
    });
    console.log('   • Secondary (H2):', copyResult.data.headlines?.secondary?.length || 0);
    copyResult.data.headlines?.secondary?.slice(0, 3).forEach((h) => {
      console.log('     -', h.substring(0, 60) + (h.length > 60 ? '...' : ''));
    });

    console.log('\n   CALLS TO ACTION:', copyResult.data.callsToAction?.length || 0);
    copyResult.data.callsToAction?.slice(0, 5).forEach((cta) => {
      console.log('     -', cta.text);
    });

    console.log('\n   PRODUCT NAMES:', copyResult.data.productNames?.length || 0);
    copyResult.data.productNames?.slice(0, 8).forEach((p) => {
      console.log('     -', p);
    });

    console.log('\n   KEY PHRASES:');
    console.log('   • Action words:', copyResult.data.keyPhrases?.action?.slice(0, 8).join(', '));
    console.log('   • Emotional:', copyResult.data.keyPhrases?.emotional?.slice(0, 8).join(', '));
    console.log('   • Social proof:', copyResult.data.keyPhrases?.social?.slice(0, 5).join(', '));

    console.log('\n   WRITING PATTERNS:');
    console.log('   • Avg sentence length:', copyResult.data.patterns?.averageSentenceLength, 'words');
    console.log('   • Exclamations:', copyResult.data.patterns?.punctuation?.exclamations);
    console.log('   • Questions:', copyResult.data.patterns?.punctuation?.questions);

    // 3. Generate Prompts
    console.log('\n\n3. GENERATING PROMPTS...');
    console.log('─'.repeat(50));
    const generator = getStylePromptGenerator();

    // Design prompt
    const designPrompt = generator.generateDesignPrompt(styleResult.data, {
      type: 'conversational AI interface',
      purpose: 'Build a chat widget for customer service',
    });

    // Copy prompt
    const copyPrompt = generator.generateCopyPrompt(copyResult.data, {
      type: 'product description',
      topic: 'AI-powered customer engagement platform',
      length: 'medium',
    });

    // Landing page prompt
    const landingPrompt = generator.generateLandingPagePrompt(styleResult.data, copyResult.data, {
      purpose: 'Promote conversational AI solution',
      targetAudience: 'Enterprise companies looking for AI automation',
    });

    // Social prompt
    const socialPrompt = generator.generateSocialPostPrompt(copyResult.data, {
      platform: 'linkedin',
      topic: 'AI transformation in customer service',
    });

    // Headlines prompt
    const headlinesPrompt = generator.generateHeadlinePrompt(copyResult.data, {
      topic: 'Conversational AI benefits',
      count: 5,
    });

    // CTA prompt
    const ctaPrompt = generator.generateCTAPrompt(copyResult.data, {
      action: 'schedule a demo',
      count: 5,
    });

    console.log('\n   GENERATED PROMPTS:');
    console.log('   • Design prompt:', designPrompt.length, 'chars');
    console.log('   • Copy prompt:', copyPrompt.length, 'chars');
    console.log('   • Landing page prompt:', landingPrompt.length, 'chars');
    console.log('   • Social prompt:', socialPrompt.length, 'chars');
    console.log('   • Headlines prompt:', headlinesPrompt.length, 'chars');
    console.log('   • CTA prompt:', ctaPrompt.length, 'chars');

    // 4. Show sample prompts
    console.log('\n\n4. SAMPLE GENERATED PROMPTS');
    console.log('═'.repeat(60));

    console.log('\n--- DESIGN PROMPT ---\n');
    console.log(designPrompt);

    console.log('\n\n--- LANDING PAGE PROMPT ---\n');
    console.log(landingPrompt);

    console.log('\n\n--- SOCIAL POST PROMPT ---\n');
    console.log(socialPrompt);

    console.log('\n\n--- HEADLINES PROMPT ---\n');
    console.log(headlinesPrompt);

    console.log('\n\n--- CTA PROMPT ---\n');
    console.log(ctaPrompt);

    // 5. Asset Summary
    console.log('\n\n5. ASSET COMPLETENESS CHECK');
    console.log('═'.repeat(60));

    const checks = [
      ['Fonts', styleResult.data.typography?.fonts?.length > 0],
      ['Body typography', !!styleResult.data.typography?.body],
      ['Headings', Object.keys(styleResult.data.typography?.headings || {}).length > 0],
      ['Background colors', styleResult.data.colors?.backgrounds?.length > 0],
      ['Text colors', styleResult.data.colors?.text?.length > 0],
      ['Accent colors', styleResult.data.colors?.accents?.length > 0],
      ['Button styles', styleResult.data.buttons?.length > 0],
      ['CSS variables', Object.keys(styleResult.data.cssVariables || {}).length > 0],
      ['Brand name', !!copyResult.data.brand?.name],
      ['Tone indicators', Object.values(copyResult.data.toneIndicators || {}).some((v) => v > 0)],
      [
        'Headlines',
        (copyResult.data.headlines?.primary?.length || 0) + (copyResult.data.headlines?.secondary?.length || 0) > 0,
      ],
      ['CTAs', copyResult.data.callsToAction?.length > 0],
      ['Product names', copyResult.data.productNames?.length > 0],
      ['Action phrases', copyResult.data.keyPhrases?.action?.length > 0],
      ['Emotional phrases', copyResult.data.keyPhrases?.emotional?.length > 0],
      ['Writing patterns', !!copyResult.data.patterns?.averageSentenceLength],
    ];

    let passed = 0;
    checks.forEach(([name, ok]) => {
      const status = ok ? '✓' : '✗';
      console.log('   ' + status + ' ' + name);
      if (ok) passed++;
    });

    console.log('\n   RESULT: ' + passed + '/' + checks.length + ' assets available');

    if (passed >= 14) {
      console.log('   STATUS: EXCELLENT - All key assets present for quality prompts');
    } else if (passed >= 10) {
      console.log('   STATUS: GOOD - Most assets present, prompts will be useful');
    } else {
      console.log('   STATUS: FAIR - Some assets missing, prompts may be incomplete');
    }

    // Save full reports
    fs.writeFileSync('/tmp/onereach-style-guide.md', styleResult.report);
    fs.writeFileSync('/tmp/onereach-copy-guide.md', copyResult.report);
    fs.writeFileSync('/tmp/onereach-design-prompt.md', designPrompt);
    fs.writeFileSync('/tmp/onereach-landing-prompt.md', landingPrompt);

    console.log('\n   Full reports saved to /tmp/onereach-*.md');

    console.log('\n==========================================');
    console.log('  TEST COMPLETE');
    console.log('==========================================');
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await styleExtractor.close();
    await copyExtractor.close();
  }
}

testOneReach();
