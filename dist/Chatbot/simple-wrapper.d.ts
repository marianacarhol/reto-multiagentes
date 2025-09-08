interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
}
interface ChatContext {
    guestId: string;
    room: string;
    messages: ChatMessage[];
    lastRequestId?: string;
}
export declare class SimpleChatbotWrapper {
    private contexts;
    processMessage(message: string, guestId: string, room: string): Promise<{
        response: string;
        context: ChatContext;
    }>;
    private messageToAgentInput;
    private resultToNaturalResponse;
    private formatMenuResponse;
    private formatCreateResponse;
    private formatStatusResponse;
    private formatErrorResponse;
    private isMaintenanceRequest;
    private isFoodOrder;
    private isBeverageOrder;
    private extractItems;
    private extractRequestId;
    private detectSeverity;
}
export {};
//# sourceMappingURL=simple-wrapper.d.ts.map