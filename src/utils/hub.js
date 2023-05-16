
/**
 * @file Utility functions to interact with the Hugging Face Hub (https://huggingface.co/models)
 * 
 * @module utils/hub
 */

import fs from 'fs';
import path from 'path';
import stream from 'stream/web';

import { env } from '../env.js';
import { dispatchCallback } from './core.js';

if (!globalThis.ReadableStream) {
    // @ts-ignore
    globalThis.ReadableStream = stream.ReadableStream; // ReadableStream is not a global with Node 16
}

/**
 * @typedef {Object} PretrainedOptions Options for loading a pretrained model.     
 * @property {boolean?} [options.quantized=true] Whether to load the 8-bit quantized version of the model (only applicable when loading model files).
 * @property {function} [options.progress_callback=null] If specified, this function will be called during model construction, to provide the user with progress updates.
 * @property {Object} [options.config=null] Configuration for the model to use instead of an automatically loaded configuration. Configuration can be automatically loaded when:
 * - The model is a model provided by the library (loaded with the *model id* string of a pretrained model).
 * - The model is loaded by supplying a local directory as `pretrained_model_name_or_path` and a configuration JSON file named *config.json* is found in the directory.
 * @property {string} [options.cache_dir=null] Path to a directory in which a downloaded pretrained model configuration should be cached if the standard cache should not be used.
 * @property {boolean} [options.local_files_only=false] Whether or not to only look at local files (e.g., not try downloading the model).
 * @property {string} [options.revision='main'] The specific model version to use. It can be a branch name, a tag name, or a commit id,
 * since we use a git-based system for storing models and other artifacts on huggingface.co, so `revision` can be any identifier allowed by git.
 */

class Headers extends Object {
    constructor(...args) {
        super();
        Object.assign(this, args);
    }

    get(key) {
        return this[key];
    }

    clone() {
        return new Headers(this);
    }
}

class FileResponse {
    /**
     * Mapping from file extensions to MIME types.
     */
    _CONTENT_TYPE_MAP = {
        'txt': 'text/plain',
        'html': 'text/html',
        'css': 'text/css',
        'js': 'text/javascript',
        'json': 'application/json',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
    }
    /**
     * Creates a new `FileResponse` object.
     * @param {string|URL} filePath
     */
    constructor(filePath) {
        this.filePath = filePath;
        this.headers = new Headers();

        this.exists = fs.existsSync(filePath);
        if (this.exists) {
            this.status = 200;
            this.statusText = 'OK';

            let stats = fs.statSync(filePath);
            this.headers['content-length'] = stats.size;

            this.updateContentType();

            let self = this;
            this.body = new ReadableStream({
                start(controller) {
                    self.arrayBuffer().then(buffer => {
                        controller.enqueue(new Uint8Array(buffer));
                        controller.close();
                    })
                }
            });
        } else {
            this.status = 404;
            this.statusText = 'Not Found';
            this.body = null;
        }
    }

    /**
     * Updates the 'content-type' header property of the response based on the extension of
     * the file specified by the filePath property of the current object.
     * @returns {void}
     */
    updateContentType() {
        // Set content-type header based on file extension
        const extension = this.filePath.toString().split('.').pop().toLowerCase();
        this.headers['content-type'] = this._CONTENT_TYPE_MAP[extension] ?? 'application/octet-stream';
    }

    /**
     * Clone the current FileResponse object.
     * @returns {FileResponse} A new FileResponse object with the same properties as the current object.
     */
    clone() {
        let response = new FileResponse(this.filePath);
        response.exists = this.exists;
        response.status = this.status;
        response.statusText = this.statusText;
        response.headers = this.headers.clone();
        return response;
    }

    /**
     * Reads the contents of the file specified by the filePath property and returns a Promise that
     * resolves with an ArrayBuffer containing the file's contents.
     * @returns {Promise<ArrayBuffer>} A Promise that resolves with an ArrayBuffer containing the file's contents.
     * @throws {Error} If the file cannot be read.
     */
    async arrayBuffer() {
        const data = await fs.promises.readFile(this.filePath);
        return data.buffer;
    }

    /**
     * Reads the contents of the file specified by the filePath property and returns a Promise that
     * resolves with a Blob containing the file's contents.
     * @returns {Promise<Blob>} A Promise that resolves with a Blob containing the file's contents.
     * @throws {Error} If the file cannot be read.
     */
    async blob() {
        const data = await fs.promises.readFile(this.filePath);
        return new Blob([data], { type: this.headers['content-type'] });
    }

    /**
     * Reads the contents of the file specified by the filePath property and returns a Promise that
     * resolves with a string containing the file's contents.
     * @returns {Promise<string>} A Promise that resolves with a string containing the file's contents.
     * @throws {Error} If the file cannot be read.
     */
    async text() {
        const data = await fs.promises.readFile(this.filePath, 'utf8');
        return data;
    }

    /**
     * Reads the contents of the file specified by the filePath property and returns a Promise that
     * resolves with a parsed JavaScript object containing the file's contents.
     * 
     * @returns {Promise<Object>} A Promise that resolves with a parsed JavaScript object containing the file's contents.
     * @throws {Error} If the file cannot be read.
     */
    async json() {
        return JSON.parse(await this.text());
    }
}

/**
 * Determines whether the given string is a valid HTTP or HTTPS URL.
 * @param {string|URL} string The string to test for validity as an HTTP or HTTPS URL.
 * @returns {boolean} True if the string is a valid HTTP or HTTPS URL, false otherwise.
 */
function isValidHttpUrl(string) {
    // https://stackoverflow.com/a/43467144
    let url;
    try {
        url = new URL(string);
    } catch (_) {
        return false;
    }
    return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * Helper function to get a file, using either the Fetch API or FileSystem API.
 *
 * @param {URL|string} urlOrPath The URL/path of the file to get.
 * @returns {Promise<FileResponse|Response>} A promise that resolves to a FileResponse object (if the file is retrieved using the FileSystem API), or a Response object (if the file is retrieved using the Fetch API).
 */
export async function getFile(urlOrPath) {
    // Helper function to get a file, using either the Fetch API or FileSystem API

    if (env.useFS && !isValidHttpUrl(urlOrPath)) {
        return new FileResponse(urlOrPath);

    } else {
        return fetch(urlOrPath);
    }
}

/**
 * Helper method to handle fatal errors that occur while trying to load a file from the Hugging Face Hub.
 * @param {number} status The HTTP status code of the error.
 * @param {string} remoteURL The URL of the file that could not be loaded.
 * @param {boolean} fatal Whether to raise an error if the file could not be loaded.
 * @returns {null} Returns `null` if `fatal = true`.
 * @throws {Error} If `fatal = false`.
 */
function handleError(status, remoteURL, fatal) {
    if (!fatal) {
        // File was not loaded correctly, but it is optional.
        // TODO in future, cache the response?
        return null;
    }

    switch (status) {
        // 4xx errors (https://developer.mozilla.org/en-US/docs/Web/HTTP/Status#client_error_responses)
        case 400:
            throw Error(`Bad request error occurred while trying to load file: "${remoteURL}".`)
        case 401:
            throw Error(`Unauthorized access to file: "${remoteURL}".`)
        case 403:
            throw Error(`Forbidden access to file: "${remoteURL}".`)
        case 404:
            throw Error(`Could not locate file: "${remoteURL}".`)
        case 408:
            throw Error(`Request timeout error occurred while trying to load file: "${remoteURL}".`)

        // 5xx errors (https://developer.mozilla.org/en-US/docs/Web/HTTP/Status#server_error_responses)
        case 500:
            throw Error(`Internal server error error occurred while trying to load file: "${remoteURL}".`)
        case 502:
            throw Error(`Bad gateway error occurred while trying to load file: "${remoteURL}".`)
        case 503:
            throw Error(`Service unavailable error occurred while trying to load file: "${remoteURL}".`)
        case 504:
            throw Error(`Gateway timeout error occurred while trying to load file: "${remoteURL}".`)

        // Other:
        default:
            throw Error(`Error (${status}) occurred while trying to load file: "${remoteURL}".`)
    }
}

class FileCache {
    /**
     * Instantiate a `FileCache` object.
     * @param {string} path 
     */
    constructor(path) {
        this.path = path;
    }

    /**
     * Checks whether the given request is in the cache.
     * @param {string} request 
     * @returns {Promise<FileResponse | undefined>}
     */
    async match(request) {

        let filePath = path.join(this.path, request);
        let file = new FileResponse(filePath);

        if (file.exists) {
            return file;
        } else {
            return undefined;
        }
    }

    /**
     * Adds the given response to the cache.
     * @param {string} request 
     * @param {Response|FileResponse} response 
     * @returns {Promise<void>}
     */
    async put(request, response) {
        const buffer = Buffer.from(await response.arrayBuffer());

        let outputPath = path.join(this.path, request);

        try {
            await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.promises.writeFile(outputPath, buffer);

        } catch (err) {
            console.warn('An error occurred while writing the file to cache:', err)
        }
    }

    // TODO add the rest?
    // addAll(requests: RequestInfo[]): Promise<void>;
    // delete(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<boolean>;
    // keys(request?: RequestInfo | URL, options?: CacheQueryOptions): Promise<ReadonlyArray<Request>>;
    // match(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<Response | undefined>;
    // matchAll(request?: RequestInfo | URL, options?: CacheQueryOptions): Promise<ReadonlyArray<Response>>;
}
/**
 * 
 * Retrieves a file from either a remote URL using the Fetch API or from the local file system using the FileSystem API.
 * If the filesystem is available and `env.useCache = true`, the file will be downloaded and cached.
 * 
 * @param {string} path_or_repo_id This can be either:
 * - a string, the *model id* of a model repo on huggingface.co.
 * - a path to a *directory* potentially containing the file.
 * @param {string} filename The name of the file to locate in `path_or_repo`.
 * @param {boolean} [fatal=true] Whether to throw an error if the file is not found.
 * @param {PretrainedOptions} [options] An object containing optional parameters.
 * 
 * @throws Will throw an error if the file is not found and `fatal` is true.
 * @returns {Promise} A Promise that resolves with the file content as a buffer.
 */
export async function getModelFile(path_or_repo_id, filename, fatal = true, options = {}) {

    if (!env.allowLocalModels) {
        // User has disabled local models, so we just make sure other settings are correct.

        if (options.local_files_only) {
            throw Error("Invalid configuration detected: local models are disabled (`env.allowLocalModels=false`) but you have requested to only use local models (`local_files_only=true`).")
        } else if (!env.allowRemoteModels) {
            throw Error("Invalid configuration detected: both local and remote models are disabled. Fix by setting `env.allowLocalModels` or `env.allowRemoteModels` to `true`.")
        }
    }

    // Initiate file retrieval
    dispatchCallback(options.progress_callback, {
        status: 'initiate',
        name: path_or_repo_id,
        file: filename
    })

    // First, check if the a caching backend is available
    // If no caching mechanism available, will download the file every time
    let cache;
    if (!cache && env.useBrowserCache) {
        if (typeof caches === 'undefined') {
            throw Error('Browser cache is not available in this environment.')
        }
        cache = await caches.open('transformers-cache');
    }

    if (!cache && env.useFSCache) {
        // TODO throw error if not available

        // If `cache_dir` is not specified, use the default cache directory
        cache = new FileCache(options.cache_dir ?? env.cacheDir);
    }

    const request = pathJoin(path_or_repo_id, filename);

    /** @type {Response} */
    let responseToCache;

    /** @type {Response | FileResponse} */
    let response;

    if (cache) {
        // Cache available, so we try to get the file from the cache.
        response = await cache.match(request);
    }

    if (response === undefined) {
        // Caching not available, or file is not cached, so we perform the request

        let isURL = isValidHttpUrl(request);
        let localPath = pathJoin(env.localModelPath, request);

        if (env.allowLocalModels) {
            // Accessing local models is enabled, so we try to get the file locally.
            // If request is a valid HTTP URL, we skip the local file check. Otherwise, we try to get the file locally.
            if (!isURL) {
                try {
                    response = await getFile(localPath);
                } catch (e) {
                    // Something went wrong while trying to get the file locally.
                    // NOTE: error handling is done in the next step (since `response` will be undefined)
                    console.warn(`Unable to load from local path "${localPath}": "${e}"`);
                }
            } else if (options.local_files_only) {
                throw new Error(`\`local_files_only=true\`, but attempted to load a remote file from: ${request}.`);
            } else if (!env.allowRemoteModels) {
                throw new Error(`\`env.allowRemoteModels=false\`, but attempted to load a remote file from: ${request}.`);
            }
        }

        if (response === undefined || response.status === 404) {
            // File not found locally. This means either:
            // - The user has disabled local file access (`env.allowLocalModels=false`)
            // - the path is a valid HTTP url (`response === undefined`)
            // - the path is not a valid HTTP url and the file is not present on the file system or local server (`response.status === 404`)

            if (options.local_files_only || !env.allowRemoteModels) {
                // User requested local files only, but the file is not found locally.
                if (fatal) {
                    throw Error(`\`local_files_only=true\` or \`env.allowRemoteModels=false\` and file was not found locally at "${localPath}".`);
                } else {
                    // File not found, but this file is optional.
                    // TODO in future, cache the response?
                    return null;
                }
            }

            // File not found locally, so we try to download it from the remote server
            let remoteURL = pathJoin(
                env.remoteHost,
                env.remotePathTemplate
                    .replace('{model}', path_or_repo_id)
                    .replace('{revision}', options.revision ?? 'main'),
                filename
            );
            response = await getFile(remoteURL);

            if (response.status !== 200) {
                return handleError(response.status, remoteURL, fatal);
            }
        }


        if (cache && response instanceof Response && response.status === 200) {
            // only clone if cache available, and response is valid
            responseToCache = response.clone();
        }
    }


    // Start downloading
    dispatchCallback(options.progress_callback, {
        status: 'download',
        name: path_or_repo_id,
        file: filename
    })

    const buffer = await readResponse(response, data => {
        dispatchCallback(options.progress_callback, {
            status: 'progress',
            ...data,
            name: path_or_repo_id,
            file: filename
        })
    })


    if (
        // Only cache web responses
        // i.e., do not cache FileResponses (prevents duplication)
        responseToCache
        &&
        // Check again whether request is in cache. If not, we add the response to the cache
        (await cache.match(request) === undefined)
    ) {
        await cache.put(request, responseToCache)
            .catch(err => {
                // Do not crash if unable to add to cache (e.g., QuotaExceededError).
                // Rather, log a warning and proceed with execution.
                console.warn(`Unable to add ${request} to browser cache: ${err}.`);
            });
    }

    dispatchCallback(options.progress_callback, {
        status: 'done',
        name: path_or_repo_id,
        file: filename
    });

    return buffer;
}

/**
 * Fetches a JSON file from a given path and file name.
 *
 * @param {string} modelPath The path to the directory containing the file.
 * @param {string} fileName The name of the file to fetch.
 * @param {boolean} [fatal=true] Whether to throw an error if the file is not found.
 * @param {PretrainedOptions} [options] An object containing optional parameters.
 * @returns {Promise<Object>} The JSON data parsed into a JavaScript object.
 * @throws Will throw an error if the file is not found and `fatal` is true.
 */
export async function getModelJSON(modelPath, fileName, fatal = true, options = {}) {
    let buffer = await getModelFile(modelPath, fileName, fatal, options);
    if (buffer === null) {
        // Return empty object
        return {}
    }

    let decoder = new TextDecoder('utf-8');
    let jsonData = decoder.decode(buffer);

    return JSON.parse(jsonData);
}

/**
 * Read and track progress when reading a Response object
 *
 * @param {any} response The Response object to read
 * @param {function} progress_callback The function to call with progress updates
 * @returns {Promise<Uint8Array>} A Promise that resolves with the Uint8Array buffer
 */
async function readResponse(response, progress_callback) {
    // Read and track progress when reading a Response object

    const contentLength = response.headers.get('Content-Length');
    if (contentLength === null) {
        console.warn('Unable to determine content-length from response headers. Will expand buffer when needed.')
    }
    let total = parseInt(contentLength ?? '0');
    let buffer = new Uint8Array(total);
    let loaded = 0;

    const reader = response.body.getReader();
    async function read() {
        const { done, value } = await reader.read();
        if (done) return;

        let newLoaded = loaded + value.length;
        if (newLoaded > total) {
            total = newLoaded;

            // Adding the new data will overflow buffer.
            // In this case, we extend the buffer
            let newBuffer = new Uint8Array(total);

            // copy contents
            newBuffer.set(buffer);

            buffer = newBuffer;
        }
        buffer.set(value, loaded)
        loaded = newLoaded;

        const progress = (loaded / total) * 100;

        // Call your function here
        progress_callback({
            progress: progress,
            loaded: loaded,
            total: total,
        })

        return read();
    }

    // Actually read
    await read();

    return buffer;
}

/**
 * Joins multiple parts of a path into a single path, while handling leading and trailing slashes.
 *
 * @param {...string} parts Multiple parts of a path.
 * @returns {string} A string representing the joined path.
 */
function pathJoin(...parts) {
    // https://stackoverflow.com/a/55142565
    parts = parts.map((part, index) => {
        if (index) {
            part = part.replace(new RegExp('^/'), '');
        }
        if (index !== parts.length - 1) {
            part = part.replace(new RegExp('/$'), '');
        }
        return part;
    })
    return parts.join('/');
}