#!/usr/bin/env node

/**
 * Test script to verify the OneReach API endpoint is working
 * Run with: node test-api-endpoint.js
 */

const https = require('https');
const fs = require('fs');

const API_URL = 'https://em.staging.api.onereach.ai/http/48cc49ef-ab05-4d51-acc6-559c7ff22150/idw_quick_starts';

console.log('Testing OneReach API endpoint...\n');
console.log('URL:', API_URL);
console.log('-----------------------------------\n');

function testApi() {
  return new Promise((resolve, reject) => {
    https
      .get(API_URL, (res) => {
        let data = '';

        console.log(`Status Code: ${res.statusCode}`);
        console.log(`Content-Type: ${res.headers['content-type']}\n`);

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const jsonData = JSON.parse(data);

            console.log('✅ Successfully received JSON response!\n');
            console.log('Response structure:');
            console.log('-------------------');

            // Display the structure of the response
            function displayStructure(obj, indent = '') {
              for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                  const value = obj[key];
                  const type = Array.isArray(value) ? 'array' : typeof value;

                  if (type === 'object' && value !== null) {
                    console.log(`${indent}${key}: {`);
                    displayStructure(value, indent + '  ');
                    console.log(`${indent}}`);
                  } else if (type === 'array') {
                    console.log(`${indent}${key}: [${value.length} items]`);
                    if (value.length > 0 && typeof value[0] === 'object') {
                      console.log(`${indent}  [0]: {`);
                      displayStructure(value[0], indent + '    ');
                      console.log(`${indent}  }`);
                    }
                  } else {
                    const displayValue =
                      type === 'string' && value.length > 50 ? value.substring(0, 50) + '...' : value;
                    console.log(`${indent}${key}: (${type}) ${displayValue}`);
                  }
                }
              }
            }

            displayStructure(jsonData);

            // Save the response to a file for reference
            const filename = 'api-response-actual.json';
            fs.writeFileSync(filename, JSON.stringify(jsonData, null, 2));
            console.log(`\n✅ Full response saved to: ${filename}`);

            // Check if it matches our expected structure
            console.log('\n-----------------------------------');
            console.log('Checking for expected fields:');
            console.log('-----------------------------------');

            const expectedFields = ['user', 'featured', 'categories', 'recommendations'];
            expectedFields.forEach((field) => {
              const exists = field in jsonData;
              console.log(`${exists ? '✅' : '❌'} ${field}: ${exists ? 'present' : 'missing'}`);
            });

            resolve(jsonData);
          } catch (error) {
            console.error('❌ Failed to parse JSON response');
            console.error('Error:', error.message);
            console.error('\nRaw response (first 500 chars):');
            console.error(data.substring(0, 500));

            // Save raw response for debugging
            fs.writeFileSync('api-response-raw.txt', data);
            console.error('\nFull raw response saved to: api-response-raw.txt');

            reject(error);
          }
        });
      })
      .on('error', (error) => {
        console.error('❌ Request failed');
        console.error('Error:', error.message);
        reject(error);
      });
  });
}

// Run the test
testApi()
  .then(() => {
    console.log('\n✅ API test completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Check api-response-actual.json to see the data structure');
    console.log('2. Update lessons-api.js if needed to handle the actual response format');
    console.log('3. Run npm start to test the integration in the app');
  })
  .catch((_error) => {
    console.error('\n❌ API test failed');
    console.error('Please check the error messages above');
    process.exit(1);
  });
