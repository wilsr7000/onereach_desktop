# UXmag Article Submission

## Goal
Generate a professional email to UXmag editors requesting publication of an author's article.

## Steps

1. **Read the article link** -- Open the URL item and note the article title and topic.
2. **Read the author bio** -- Read the markdown bio to understand the author's credentials and expertise.
3. **Read the author email** -- Note the author's email address for the CC line.
4. **Draft the submission email** -- Write a professional email to editors@uxmag.com:
   - Subject: Article Submission - [Article Title] by [Author Name]
   - Introduce the author using their bio
   - Pitch the article with a brief summary
   - Include the article link
   - CC the author
   - Professional, warm tone
5. **Store author in metadata** -- Write a JSON file with the author's name, email, and bio summary for future reference.

## Expected Outputs
- `submission-email.html` -- The formatted email (type: document, render: true)
- `author-record.json` -- Author metadata for key-value storage (type: data)
