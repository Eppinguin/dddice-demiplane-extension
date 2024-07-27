(function() {
  console.log('Demiplane script injected');
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  let xhrInstance: XMLHttpRequest;

  // Custom XMLHttpRequest class
  class CustomXMLHttpRequest extends XMLHttpRequest {
    private _url: string | URL | undefined;

    open(method: string, url: string | URL, async: boolean, user?: string, password?: string) {
      this._url = url;
      originalOpen.apply(this, arguments);
    }

    send(body?: Document | BodyInit | null) {
      if (this._url && typeof this._url === 'string' && this._url.includes('https://utils-api.demiplane.com/dice-roll?roll=')) {
        console.log('Intercepting request for URL:', this._url);

        this.addEventListener('readystatechange', function() {
          if (this.readyState === 4) {
            console.log('Request completed. Replaced with custom response.');
          }
        });

        // Capture the current instance
        xhrInstance = this as XMLHttpRequest;
        console.log('Captured xhr instance:', xhrInstance);
        // Dispatch event with the request URL and xhr instance
        const responseEvent = new CustomEvent('diceRollRequest', { detail: { url: this._url} });
        window.dispatchEvent(responseEvent);
      } else {
        // Proceed with the original send method
        console.log('Proceeding with the original send method');
        originalSend.apply(this, arguments);
      }
    }
  }

  // Monkey patch the responseText property
  Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
    get: function() {
      return this._response || '';
    },
    set: function(value) {
      this._response = value;
    },
    configurable: true
  });

  // Global event listener for diceRollResponse
  window.addEventListener('diceRollResponse', (event: CustomEvent) => {
    const responseText = event.detail.responseText;
    console.log('Received diceRollResponse event:', event);
    // Set the custom response on the original XMLHttpRequest
    const xhr = xhrInstance as XMLHttpRequest;
    if (xhr) {
      xhr.responseText = responseText;
      console.log('Updated xhr:', xhr);
      // Call the original send method to ensure the request is sent
      originalSend.apply(xhr, []);
    } else {
      console.error('XMLHttpRequest instance is missing in the event detail.');
    }
  });

  // Replace the global XMLHttpRequest with the custom one
  window.XMLHttpRequest = CustomXMLHttpRequest;
})();