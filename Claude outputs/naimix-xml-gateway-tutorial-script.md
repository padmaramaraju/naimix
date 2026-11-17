# Naimix tutorial: Creating an XML gateway (about 70 seconds)

Narration for the video, one line per on-screen caption. Pause points are where the video waits for a click or typing.

1. **Title.** "Creating an XML gateway."
2. **Sign in.** A gateway is a reusable connection to a backend. Sign in to the console first with your console token.
3. **Open Gateways.** Open Gateways in the Shared Collection. This lists the gateways that already exist. Click Add Gateway.
4. **Name.** Give the gateway a name. Integrations will refer to it by this name. (Typed: `customerXml`)
5. **Kind.** Set the kind to xml. The fields below change to match.
6. **Base URL.** The root address that every integration using this gateway will call. (Typed: `https://api.example.com/xml`)
7. **Headers (optional).** Add headers sent with every request through this gateway. (Typed: `Accept` = `application/xml`)
8. **Common parameters.** These become `{name}` placeholders for every integration on this gateway. (Typed: `apiVersion` = `v2`)
9. **Save.** Click Save gateway. The gateway is ready to use from any integration.
10. **Result.** It now appears in the Gateways list, with type xml.
11. **End card.** Next: create an integration that calls this gateway.

Note: the console was shown with sample data and a stand-in for the API, so nothing was written to a real workspace.
