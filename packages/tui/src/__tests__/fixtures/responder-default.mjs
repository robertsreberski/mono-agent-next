export default {
  async respond(request) {
    return { text: `default responder: ${request.text}` };
  },
};
