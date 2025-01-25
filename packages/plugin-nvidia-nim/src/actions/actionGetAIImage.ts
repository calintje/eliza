import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, ActionExample, Media } from "@elizaos/core";
import axios from 'axios';
import fs from 'fs';
import { validateNvidiaNimConfig, getNetworkConfig, getConfig } from "../environment.js";
import { parseAIImagePrompt } from "../utils/aiImagePromptParser.js";
import { AIImageContent, AIImageResponse, AIImageAnalysis } from "../types/aiImage.js";
import { AssetManager } from "../utils/assetManager.js";
import { NimError, NimErrorCode, ErrorSeverity } from "../errors/nimErrors.js";
import path from 'path';

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.NVIDIA_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[AIImageDetection] ${message}`, data);
        console.log(`[AIImageDetection] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface ApiHeaders {
    Authorization: string;
    Accept: string;
    'Content-Type'?: string;
    'NVCF-INPUT-ASSET-REFERENCES'?: string;
    [key: string]: string | undefined;
}

export const getAIImageAction: Action = {
    name: "GET_AI_IMAGE",
    similes: ["CHECK_AI_IMAGE", "ANALYZE_AI_IMAGE", "AI_IMAGE_CONTROL"],
    description: "Use NVIDIA AI Image detection model to analyze if images were generated by AI",
    examples: [[
        {
            user: "user",
            content: {
                text: "Check if this image is AI generated [IMAGE]\ntest_ai.jpg\n[/IMAGE]  ",
                mediaPath: "test_ai.jpg"
            } as AIImageContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "AI Image Analysis: Image is 99.94% likely to be AI-generated. Most likely source: Stable Diffusion XL (88.75% confidence).",
                success: true,
                data: {
                    response: "Detected AI-generated image",
                    analysis: [{
                        index: 0,
                        is_ai_generated: 0.9994,
                        possible_sources: {
                            stablediffusionxl: 0.8875,
                            midjourney: 0.0136,
                            dalle: 0.0518,
                        },
                        status: "SUCCESS"
                    }]
                }
            } as AIImageContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_AI_IMAGE") {
            return true;
        }

        logGranular("Validating GET_AI_IMAGE action", {
            content: message.content
        });

        try {
            const content = message.content as AIImageContent;

            if (!content.text) {
                throw new NimError(
                    NimErrorCode.VALIDATION_FAILED,
                    "text content is required",
                    ErrorSeverity.HIGH
                );
            }

            return true;
        } catch (error) {
            logGranular("Validation failed", { error });
            elizaLogger.error("Validation failed for GET_AI_IMAGE", {
                error: error instanceof Error ? error.message : String(error)
            });
            return false;
        }
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        logGranular("Executing GET_AI_IMAGE action");

        try {
            const messageContent = message.content as AIImageContent;
            console.log("Debug - Full message content:", {
                fullContent: message.content,
                rawText: messageContent?.text,
                type: message.content?.type,
                allKeys: Object.keys(message.content || {}),
                attachments: message.content?.attachments
            });

            console.log("Debug - Message content details:", {
                hasText: !!messageContent?.text,
                hasMediaFile: !!messageContent?.mediaFile,
                hasAttachments: !!message.content?.attachments?.length,
                textContent: messageContent?.text,
                mediaFile: messageContent?.mediaFile,
                contentType: typeof messageContent?.text,
                attachmentCount: message.content?.attachments?.length || 0,
                firstAttachmentUrl: message.content?.attachments?.[0]?.url,
                firstAttachmentType: message.content?.attachments?.[0]?.contentType
            });

            const config = await validateNvidiaNimConfig(runtime);
            console.log("Debug - Config validated:", {
                hasApiKey: !!config.NVIDIA_NIM_API_KEY,
                env: config.NVIDIA_NIM_ENV
            });

            const networkConfig = getNetworkConfig(config.NVIDIA_NIM_ENV);
            console.log("Debug - Network config:", {
                hasBaseUrl: !!networkConfig?.baseUrl,
                baseUrl: networkConfig?.baseUrl
            });

            // Parse the prompt using our helper
            console.log("Debug - Raw prompt:", {
                text: messageContent.text,
                hasMediaFile: !!messageContent.mediaFile,
                mediaFile: messageContent.mediaFile,
                promptLength: messageContent.text?.length,
                attachments: message.content?.attachments
            });

            const parsedPrompt = await parseAIImagePrompt(
                messageContent.text,
                message.content?.attachments,
                config.NVIDIA_NIM_API_KEY
            );
            console.log("Debug - Parsed content:", {
                hasMediaFile: !!parsedPrompt.mediaFile,
                mediaPath: parsedPrompt.mediaFile,
                mediaLength: parsedPrompt.mediaFile?.length,
                isBase64: parsedPrompt.isBase64
            });

            let imageB64: string;
            let fileData: Buffer;
            let mediaPath: string = '';
            let workspaceRoot: string;
            let aiImageDir: string;

            if (parsedPrompt.isBase64) {
                // Image is already in base64 format from chat
                console.log("Debug - Using base64 image from chat");
                imageB64 = parsedPrompt.mediaFile.split('base64,')[1]; // Remove the data:image/jpeg;base64, prefix
                fileData = Buffer.from(imageB64, 'base64');

                // Set up paths for potential temp file storage
                workspaceRoot = process.cwd().replace('/agent', '');
                while (!fs.existsSync(path.join(workspaceRoot, 'packages')) && workspaceRoot !== path.parse(workspaceRoot).root) {
                    workspaceRoot = path.dirname(workspaceRoot);
                }
                aiImageDir = path.join(workspaceRoot, 'packages', 'plugin-nvidia-nim', 'src', 'assets', 'aiimage');

                // Create temp file for base64 image
                const tempDir = path.join(aiImageDir, 'temp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                mediaPath = path.join(tempDir, `temp_${Date.now()}.jpg`);
                fs.writeFileSync(mediaPath, fileData);
            } else {
                // Image is a file path
                // Find the workspace root by looking for packages directory
                // workspaceRoot = process.cwd();
                workspaceRoot = process.cwd().replace('/agent', '');
                while (!fs.existsSync(path.join(workspaceRoot, 'packages')) && workspaceRoot !== path.parse(workspaceRoot).root) {
                    workspaceRoot = path.dirname(workspaceRoot);
                }

                console.log("Debug - Workspace detection:", {
                    workspaceRoot,
                    hasPackagesDir: fs.existsSync(path.join(workspaceRoot, 'packages'))
                });

                aiImageDir = path.join(workspaceRoot, 'packages', 'plugin-nvidia-nim', 'src', 'assets', 'aiimage');
                mediaPath = path.join(aiImageDir, parsedPrompt.mediaFile);
                const absolutePath = path.resolve(mediaPath);

                console.log("Debug - File paths:", {
                    workspaceRoot,
                    aiImageDir,
                    mediaPath,
                    absolutePath,
                    cwd: process.cwd(),
                    exists: fs.existsSync(mediaPath),
                    dirExists: fs.existsSync(aiImageDir)
                });

                // Ensure aiimage directory exists
                if (!fs.existsSync(aiImageDir)) {
                    console.log("Debug - Creating aiimage directory");
                    fs.mkdirSync(aiImageDir, { recursive: true });
                }

                // Test file access
                try {
                    await fs.promises.access(mediaPath, fs.constants.R_OK);
                    console.log("Debug - File is readable at path:", mediaPath);

                    const stats = await fs.promises.stat(mediaPath);
                    console.log("Debug - File stats:", {
                        size: stats.size,
                        isFile: stats.isFile(),
                        permissions: stats.mode
                    });
                } catch (error) {
                    console.error("Debug - File access error:", {
                        error: error instanceof Error ? error.message : String(error),
                        path: mediaPath
                    });
                }

                // Ensure the file exists
                if (!fs.existsSync(mediaPath)) {
                    console.error(`Media file not found: ${mediaPath}`);
                    // Try listing directory contents
                    try {
                        const dirContents = await fs.promises.readdir(path.dirname(mediaPath));
                        console.log("Debug - Directory contents:", {
                            path: path.dirname(mediaPath),
                            files: dirContents
                        });
                    } catch (dirError) {
                        console.error("Debug - Failed to read directory:", dirError);
                    }
                    throw new NimError(
                        NimErrorCode.FILE_NOT_FOUND,
                        `Media file not found: ${mediaPath}`,
                        ErrorSeverity.HIGH
                    );
                }

                // Read the file
                console.log("Debug - Reading file from path");
                fileData = fs.readFileSync(mediaPath);
                imageB64 = fileData.toString('base64');
            }

            // ------------------------------------------------------------------------------------------------
            // Core AI Image detection logic
            // ------------------------------------------------------------------------------------------------
            logGranular("Making request to NVIDIA NIM API", {
                model: "hive/ai-generated-image-detection",
                hasMediaFile: true,
                imageSize: fileData.length,
                isBase64Image: parsedPrompt.isBase64
            });

            try {
                let payload;
                let headers: ApiHeaders = {
                    "Authorization": `Bearer ${config.NVIDIA_NIM_API_KEY}`,
                    "Accept": "application/json"
                };

                // Handle large files through asset upload
                if (imageB64.length < 180000) {
                    payload = {
                        input: [`data:image/jpeg;base64,${imageB64}`]
                    };
                    headers["Content-Type"] = "application/json";
                } else {
                    // For base64 images from chat, we need to save them first
                    let tempPath: string | null = null;
                    let uploadPath = mediaPath;
                    //let uploadPath = path.join(workspaceRoot, mediaPath);

                    if (parsedPrompt.isBase64) {
                        const tempDir = path.join(workspaceRoot, 'packages', 'plugin-nvidia-nim', 'src', 'assets', 'aiimage', 'temp');
                        //const tempDir = path.join(workspaceRoot, 'packages', 'plugin-nvidia-nim', 'src', 'assets', 'deepfake', 'temp');
                        if (!fs.existsSync(tempDir)) {
                            fs.mkdirSync(tempDir, { recursive: true });
                        }
                        tempPath = path.join(tempDir, `temp_${Date.now()}_large.jpg`);
                        fs.writeFileSync(tempPath, fileData);
                        uploadPath = tempPath;
                    }

                    // Upload the file and get the asset ID
                    const assetManager = new AssetManager(config.NVIDIA_NIM_API_KEY);
                    const uploadedAsset = await assetManager.uploadAsset(uploadPath);

                    // Clean up temp file if we created one
                    if (tempPath && fs.existsSync(tempPath)) {
                        fs.unlinkSync(tempPath);
                    }

                    payload = {
                        input: [`data:image/jpeg;asset_id,${uploadedAsset.assetId}`]
                    };
                    headers["Content-Type"] = "application/json";
                    headers["NVCF-INPUT-ASSET-REFERENCES"] = uploadedAsset.assetId;
                }

                // Make the API request
                const apiUrl = 'https://ai.api.nvidia.com/v1/cv/hive/ai-generated-image-detection';
                console.log("Debug - Making API request:", {
                    url: apiUrl,
                    payloadSize: JSON.stringify(payload).length,
                    hasAuth: !!headers.Authorization
                });

                const { data: response } = await axios.post(
                    apiUrl,
                    payload,
                    {
                        headers,
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity
                    }
                );

                console.log("Debug - API Response received:", {
                    status: 'success',
                    dataLength: JSON.stringify(response).length
                });

                const aiImageResponse = response as AIImageResponse;

                logGranular("Successfully received response from NVIDIA NIM", {
                    response: aiImageResponse
                });

                // Process the analysis results
                const analysis: AIImageAnalysis = aiImageResponse.data[0];

                logGranular("Processing analysis results", {
                    analysis
                });

                const aiProbability = (analysis.is_ai_generated * 100).toFixed(2);

                // Find the most likely source
                const sources = Object.entries(analysis.possible_sources);
                const topSource = sources.reduce((prev, curr) =>
                    curr[1] > prev[1] ? curr : prev
                );
                const sourceConfidence = (topSource[1] * 100).toFixed(2);

                const analysisText = `AI Image Analysis: Image is ${aiProbability}% likely to be AI-generated. ${
                    topSource[0] !== 'none'
                        ? `Most likely source: ${topSource[0]} (${sourceConfidence}% confidence).`
                        : 'No specific AI source identified.'
                }`;

                const processedData = {
                    response: "Analyzed image for AI generation",
                    analysis: [analysis]
                };

                if (callback) {
                    callback({
                        text: analysisText,
                        success: true,
                        mediaPath,
                        data: processedData
                    } as AIImageContent);
                }

                return true;
            } catch (error) {
                logGranular("Failed to get response from NVIDIA NIM", { error });
                if (callback) {
                    callback({
                        text: `Error analyzing image: ${error instanceof Error ? error.message : String(error)}`,
                        success: false,
                        mediaPath: mediaPath,
                        data: {
                            error: error instanceof Error ? error.message : String(error)
                        }
                    } as AIImageContent);
                }
                throw new NimError(
                    NimErrorCode.API_ERROR,
                    "Failed to get response from NVIDIA NIM",
                    ErrorSeverity.HIGH,
                    { originalError: error }
                );
            }
        } catch (error) {
            logGranular("Failed to execute GET_AI_IMAGE action", { error });
            throw new NimError(
                NimErrorCode.NETWORK_ERROR,
                "Failed to execute GET_AI_IMAGE action",
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }
};

export default getAIImageAction;
