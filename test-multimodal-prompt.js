const { getStyleGuideExtractor } = require('./style-guide-extractor');
const { getCopyStyleExtractor } = require('./copy-style-extractor');
const { getStylePromptGenerator } = require('./style-prompt-generator');
const { getScreenshotCapture } = require('./screenshot-capture');
const fs = require('fs');

async function testMultimodalPrompt() {
  console.log('==========================================');
  console.log('  MULTIMODAL PROMPT TEST - ONEREACH.AI');
  console.log('==========================================');

  const styleExtractor = getStyleGuideExtractor();
  const copyExtractor = getCopyStyleExtractor();
  const screenshotCapture = getScreenshotCapture();
  const generator = getStylePromptGenerator();

  try {
    const url = 'https://onereach.ai';

    // 1. Capture screenshots
    console.log('\n1. CAPTURING SCREENSHOTS...');
    console.log('─'.repeat(50));

    await screenshotCapture.init();

    // Full page screenshot - returns Buffer, convert to base64
    console.log('   Capturing full page...');
    const fullPageBuffer = await screenshotCapture.capture(url, {
      fullPage: true,
      delay: 2000,
      waitForIdle: true,
    });
    const fullPageBase64 = fullPageBuffer.toString('base64');
    console.log('   ✓ Full page captured (' + Math.round(fullPageBase64.length / 1024) + ' KB)');

    // Hero section (viewport only)
    console.log('   Capturing hero section...');
    const heroBuffer = await screenshotCapture.capture(url, {
      fullPage: false,
      delay: 1000,
    });
    const heroBase64 = heroBuffer.toString('base64');
    console.log('   ✓ Hero section captured (' + Math.round(heroBase64.length / 1024) + ' KB)');

    // Responsive captures - returns array of {viewport, result}
    console.log('   Capturing responsive views...');
    const responsiveResults = await screenshotCapture.captureResponsive(url, null, {
      delay: 1000,
    });

    // Convert to object keyed by viewport name
    const responsive = {};
    responsiveResults.forEach((r) => {
      if (r.success && r.result) {
        responsive[r.viewport] = r.result.toString('base64');
      }
    });
    console.log('   ✓ Responsive captures: ' + Object.keys(responsive).length + ' viewports');
    Object.entries(responsive).forEach(([vp, b64]) => {
      console.log('     - ' + vp + ': ' + Math.round(b64.length / 1024) + ' KB');
    });

    // 2. Extract style guides
    console.log('\n2. EXTRACTING STYLE GUIDES...');
    console.log('─'.repeat(50));

    await styleExtractor.init();
    const styleData = await styleExtractor.extract(url);
    console.log('   ✓ Visual style extracted');

    await copyExtractor.init();
    const copyData = await copyExtractor.extract(url);
    console.log('   ✓ Copy style extracted');

    // 3. Build images array
    console.log('\n3. BUILDING IMAGE ARRAY...');
    console.log('─'.repeat(50));

    const images = [
      {
        base64: fullPageBase64,
        type: 'full-page',
        description: 'Full page screenshot of onereach.ai showing complete layout and design',
      },
      {
        base64: heroBase64,
        type: 'hero',
        description: 'Hero section - above the fold content with headline and CTA',
      },
    ];

    // Add responsive images if available
    if (responsive.tablet) {
      images.push({
        base64: responsive.tablet,
        type: 'responsive',
        description: 'Tablet viewport (768px) - responsive layout',
      });
    }
    if (responsive.mobile) {
      images.push({
        base64: responsive.mobile,
        type: 'responsive',
        description: 'Mobile viewport (375px) - mobile responsive layout',
      });
    }

    console.log('   ✓ ' + images.length + ' images prepared');
    images.forEach((img, i) => {
      console.log('     [' + i + '] ' + img.type + ': ' + Math.round(img.base64.length / 1024) + ' KB');
    });

    // 4. Generate multimodal prompt
    console.log('\n4. GENERATING MULTIMODAL PROMPT...');
    console.log('─'.repeat(50));

    const multimodalResult = generator.generateMultimodalPrompt({
      styleGuide: styleData,
      copyGuide: copyData,
      images: images,
      type: 'conversational AI landing page',
      purpose: 'Create a landing page for an AI automation product',
      targetAudience: 'Enterprise decision makers',
      additionalContext: 'Should emphasize trust, security, and enterprise-grade capabilities',
    });

    console.log('   ✓ Text prompt: ' + multimodalResult.text.length + ' chars');
    console.log('   ✓ Images: ' + multimodalResult.images.length);
    console.log('   ✓ Claude format ready');
    console.log('   ✓ OpenAI format ready');

    // 5. Generate design prompt with images
    console.log('\n5. GENERATING DESIGN PROMPT WITH IMAGES...');
    console.log('─'.repeat(50));

    const designResult = generator.generateDesignPromptWithImages(styleData, images, {
      type: 'product landing page',
      purpose: 'Showcase AI capabilities',
      additionalContext: 'Include animated elements and modern interactions',
    });

    console.log('   ✓ Design prompt: ' + designResult.text.length + ' chars');

    // 6. Display the prompts
    console.log('\n\n6. GENERATED PROMPTS');
    console.log('═'.repeat(60));

    console.log('\n--- MULTIMODAL PROMPT (TEXT PORTION) ---\n');
    console.log(multimodalResult.text);

    console.log('\n\n--- DESIGN WITH IMAGES PROMPT ---\n');
    console.log(designResult.text);

    // 7. Show API format examples
    console.log('\n\n7. API FORMAT EXAMPLES');
    console.log('═'.repeat(60));

    console.log('\n--- CLAUDE API FORMAT (structure) ---');
    const claudeFormat = multimodalResult.messages.claude[0];
    console.log('Role:', claudeFormat.role);
    console.log('Content items:', claudeFormat.content.length);
    claudeFormat.content.forEach((item, i) => {
      if (item.type === 'image') {
        console.log(
          '  [' + i + '] Image: ' + item.source.media_type + ' (' + Math.round(item.source.data.length / 1024) + ' KB)'
        );
      } else {
        console.log('  [' + i + '] Text: ' + item.text.substring(0, 50) + '...');
      }
    });

    console.log('\n--- OPENAI API FORMAT (structure) ---');
    const openaiFormat = multimodalResult.messages.openai[0];
    console.log('Role:', openaiFormat.role);
    console.log('Content items:', openaiFormat.content.length);
    openaiFormat.content.forEach((item, i) => {
      if (item.type === 'image_url') {
        const dataLen = item.image_url.url.length;
        console.log('  [' + i + '] Image URL: data:image/... (' + Math.round(dataLen / 1024) + ' KB)');
      } else {
        console.log('  [' + i + '] Text: ' + item.text.substring(0, 50) + '...');
      }
    });

    // 8. Save outputs
    console.log('\n\n8. SAVING OUTPUTS...');
    console.log('─'.repeat(50));

    fs.writeFileSync('/tmp/onereach-multimodal-prompt.md', multimodalResult.text);
    fs.writeFileSync('/tmp/onereach-design-with-images-prompt.md', designResult.text);
    fs.writeFileSync('/tmp/onereach-fullpage.png', Buffer.from(fullPageBase64, 'base64'));
    fs.writeFileSync('/tmp/onereach-hero.png', Buffer.from(heroBase64, 'base64'));
    if (responsive.mobile) {
      fs.writeFileSync('/tmp/onereach-mobile.png', Buffer.from(responsive.mobile, 'base64'));
    }

    // Save the full multimodal package as JSON (without base64 for readability)
    const packageInfo = {
      url,
      promptLength: multimodalResult.text.length,
      imageCount: multimodalResult.images.length,
      images: multimodalResult.images.map((img) => ({
        type: img.type,
        description: img.description,
        sizeKB: Math.round(img.base64.length / 1024),
      })),
      styleGuide: {
        fonts: styleData.typography?.fonts?.length || 0,
        colors: (styleData.colors?.backgrounds?.length || 0) + (styleData.colors?.accents?.length || 0),
        buttons: styleData.buttons?.length || 0,
      },
      copyGuide: {
        brand: copyData.brand?.name,
        headlines: (copyData.headlines?.primary?.length || 0) + (copyData.headlines?.secondary?.length || 0),
        ctas: copyData.callsToAction?.length || 0,
      },
    };
    fs.writeFileSync('/tmp/onereach-multimodal-package.json', JSON.stringify(packageInfo, null, 2));

    console.log('   ✓ Prompts saved to /tmp/onereach-*.md');
    console.log('   ✓ Screenshots saved to /tmp/onereach-*.png');
    console.log('   ✓ Package info saved to /tmp/onereach-multimodal-package.json');

    console.log('\n==========================================');
    console.log('  TEST COMPLETE - ALL ASSETS READY');
    console.log('==========================================');
    console.log('\nTo use with Claude or GPT-4V:');
    console.log('  - Use multimodalResult.messages.claude for Anthropic API');
    console.log('  - Use multimodalResult.messages.openai for OpenAI API');
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await styleExtractor.close();
    await copyExtractor.close();
    await screenshotCapture.close();
  }
}

testMultimodalPrompt();
