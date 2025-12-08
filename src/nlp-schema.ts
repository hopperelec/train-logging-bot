import {jsonSchema} from "ai";
import {JSONModal, LogEntryDetails, LogEntryKey, LogRemoveTransaction} from "./types";

// For compactness, details are merged into the main object
export interface NlpLogEntry extends LogEntryKey, LogEntryDetails {}

interface AcceptResponse {
    type: "accept";
    transactions: (LogRemoveTransaction | (
        { type: "add" } & NlpLogEntry
        ))[];
    notes?: string;
}

interface ClarifyResponse extends JSONModal {
    type: "clarify";
}

interface RejectResponse {
    type: "reject";
    detail: string;
}

export type NlpResponse = AcceptResponse | ClarifyResponse | RejectResponse;

export default jsonSchema<NlpResponse>({
    type: "object",
    oneOf: [
        {
            type: "object",
            properties: {
                type: {const: "accept"},
                transactions: {
                    type: "array",
                    items: {
                        oneOf: [
                            {
                                type: "object",
                                properties: {
                                    type: {const: "add"},
                                    trn: {type: "string"},
                                    units: {type: "string"},
                                    sources: {type: "string"},
                                    notes: {type: "string"},
                                    index: {type: "integer"},
                                    withdrawn: {type: "boolean"}
                                },
                                required: ["type", "trn", "units", "sources"],
                                additionalProperties: false
                            },
                            {
                                type: "object",
                                properties: {
                                    type: {const: "remove"},
                                    trn: {type: "string"},
                                    units: {type: "string"}
                                },
                                required: ["type", "trn", "units"],
                                additionalProperties: false
                            }
                        ]
                    },
                    minItems: 1
                },
                notes: {type: "string"}
            },
            required: ["type", "transactions"],
            additionalProperties: false
        },
        {
            type: "object",
            properties: {
                type: {const: "clarify"},
                title: {
                    type: "string",
                    minLength: 1,
                    maxLength: 45
                },
                components: {
                    type: "array",
                    items: {
                        oneOf: [
                            {
                                type: "object",
                                properties: {
                                    type: {const: "TextDisplay"},
                                    content: {
                                        type: "string",
                                        minLength: 1,
                                        maxLength: 2000
                                    },
                                },
                                required: ["type", "content"],
                                additionalProperties: false
                            },
                            {
                                type: "object",
                                properties: {
                                    type: {const: "TextInput"},
                                    style: {
                                        type: "string",
                                        enum: ["Short", "Paragraph"]
                                    },
                                    id: {
                                        type: "string",
                                        minLength: 1,
                                        maxLength: 100
                                    },
                                    label: {
                                        type: "string",
                                        minLength: 1,
                                        maxLength: 45
                                    },
                                    placeholder: {
                                        type: "string",
                                        maxLength: 1000
                                    },
                                    value: {
                                        type: "string",
                                        maxLength: 4000
                                    },
                                    minLength: {
                                        type: "integer",
                                        minimum: 0,
                                        maximum: 4000
                                    },
                                    maxLength: {
                                        type: "integer",
                                        minimum: 1,
                                        maximum: 4000
                                    },
                                    required: {type: "boolean"}
                                },
                                required: ["type", "style", "id", "label"],
                                additionalProperties: false
                            },
                            {
                                type: "object",
                                properties: {
                                    type: {const: "DropdownInput"},
                                    id: {
                                        type: "string",
                                        minLength: 1,
                                        maxLength: 100
                                    },
                                    label: {
                                        type: "string",
                                        minLength: 1,
                                        maxLength: 45
                                    },
                                    placeholder: {
                                        type: "string",
                                        maxLength: 100
                                    },
                                    minValues: {
                                        type: "integer",
                                        minimum: 0,
                                        maximum: 25
                                    },
                                    maxValues: {
                                        type: "integer",
                                        minimum: 1,
                                        maximum: 25
                                    },
                                    options: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                label: {
                                                    type: "string",
                                                    minLength: 1,
                                                    maxLength: 100
                                                },
                                                value: {
                                                    type: "string",
                                                    minLength: 1,
                                                    maxLength: 100
                                                },
                                                description: {
                                                    type: "string",
                                                    maxLength: 100
                                                }
                                            },
                                            required: ["label", "value"],
                                            additionalProperties: false
                                        },
                                        minItems: 1,
                                        maxItems: 25
                                    }
                                },
                                required: ["type", "id", "label", "options"],
                                additionalProperties: false
                            }
                        ]
                    },
                    minItems: 1,
                    maxItems: 5
                }
            },
            required: ["type", "title", "components"],
            additionalProperties: false,
        },
        {
            type: "object",
            properties: {
                type: {const: "reject"},
                detail: {type: "string"}
            },
            required: ["type", "detail"],
            additionalProperties: false
        }
    ]
})