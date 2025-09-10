self.addEventListener('fetch', event => {
    if (event.request.url.includes('/article-proxy/')) {
        event.respondWith(
            fetch(event.request.url.replace('/article-proxy/', ''))
                .then(response => {
                    return new Response(response.body, {
                        headers: {
                            'Content-Type': response.headers.get('Content-Type'),
                            'Access-Control-Allow-Origin': '*'
                        }
                    });
                })
        );
    }
}); 