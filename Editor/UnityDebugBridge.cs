using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;

/// <summary>
/// Provides a TCP-based debug bridge that enables Antigravity IDE to communicate
/// with the Unity Editor for debugging purposes. This bridge acts as a relay between
/// the IDE's debug adapter and Unity's Mono debugger.
/// </summary>
[InitializeOnLoad]
public static class UnityDebugBridge
{
    private static TcpListener _listener;
    private static Thread _listenerThread;
    private static bool _isRunning;
    private static readonly object _lock = new object();

    private const int DefaultPort = 56000;
    public static int CurrentPort { get; private set; } = DefaultPort;
    public static bool IsRunning => _isRunning;
    public static DateTime LastConnectionTime { get; private set; } = DateTime.MinValue;

    public static bool HasActiveConnection
    {
        get
        {
            if (!_isRunning) return false;
            return (DateTime.UtcNow - LastConnectionTime).TotalSeconds < 10;
        }
    }

    // Cached main-thread state (safe to read from background threads)
    private static string _cachedUnityVersion = "";
    private static string _cachedProjectName = "";
    private static string _cachedProjectPath = "";
    private static bool _cachedIsPlaying = false;
    private static bool _cachedIsPaused = false;
    private static bool _cachedScriptDebugging = false;
    private static int _cachedProcessId = -1;

    static UnityDebugBridge()
    {
        EditorApplication.delayCall += EvaluateBridgeState;
        EditorApplication.update += EvaluateBridgeState;
        EditorApplication.quitting += OnQuitting;
        AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
        AssemblyReloadEvents.afterAssemblyReload += OnAfterAssemblyReload;
        EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
    }

    private static void OnQuitting()
    {
        StopBridge(deleteStateFile: true);
    }

    private static void OnBeforeAssemblyReload()
    {
        StopBridge(deleteStateFile: false);
    }

    private static string GetBridgeStateFilePath()
    {
        return Path.Combine(Directory.GetCurrentDirectory(), "Library", "Antigravity", "bridge.json");
    }

    private static void WriteBridgeStateFile(int port)
    {
        try
        {
            string dir = Path.Combine(Directory.GetCurrentDirectory(), "Library", "Antigravity");
            if (!Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            string filePath = GetBridgeStateFilePath();
            int pid = System.Diagnostics.Process.GetCurrentProcess().Id;
            string projectName = Application.productName;
            string projectPath = Directory.GetCurrentDirectory().Replace("\\", "/");
            string unityVersion = Application.unityVersion;

            string json = $"{{\n" +
                         $"  \"port\": {port},\n" +
                         $"  \"processId\": {pid},\n" +
                         $"  \"projectName\": \"{EscapeJson(projectName)}\",\n" +
                         $"  \"projectPath\": \"{EscapeJson(projectPath)}\",\n" +
                         $"  \"unityVersion\": \"{EscapeJson(unityVersion)}\"\n" +
                         $"}}";

            File.WriteAllText(filePath, json, Encoding.UTF8);
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[Antigravity] Failed to write bridge state file: {ex.Message}");
        }
    }

    private static void DeleteBridgeStateFile()
    {
        try
        {
            string filePath = GetBridgeStateFilePath();
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
            }
        }
        catch
        {
            // Ignore deletion errors
        }
    }

    private static string EscapeJson(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static void UpdateMainThreadCache()
    {
        // Called only from main thread — safe to access all Unity APIs here
        _cachedUnityVersion = Application.unityVersion;
        _cachedProjectName = Path.GetFileName(Directory.GetCurrentDirectory());
        _cachedProjectPath = Directory.GetCurrentDirectory().Replace("\\", "/");
        _cachedIsPlaying = EditorApplication.isPlaying;
        _cachedIsPaused = EditorApplication.isPaused;
        _cachedScriptDebugging = EditorUserBuildSettings.allowDebugging;
        _cachedProcessId = System.Diagnostics.Process.GetCurrentProcess().Id;
    }

    public static void EvaluateBridgeState()
    {
        UpdateMainThreadCache();
        bool shouldBeRunning = AntigravityScriptEditor.IsSelectedEditor();

        if (shouldBeRunning && !_isRunning)
        {
            StartBridge();
        }
        else if (!shouldBeRunning && _isRunning)
        {
            StopBridge();
        }
    }

    private static void OnAfterAssemblyReload()
    {
        EvaluateBridgeState();
    }

    private static void EnsureDebugSettings()
    {
        try
        {
            EditorUserBuildSettings.allowDebugging = true;
#if UNITY_2020_1_OR_NEWER
            if (UnityEditor.Compilation.CompilationPipeline.codeOptimization != UnityEditor.Compilation.CodeOptimization.Debug)
            {
                UnityEditor.Compilation.CompilationPipeline.codeOptimization = UnityEditor.Compilation.CodeOptimization.Debug;
                UnityEditor.Compilation.CompilationPipeline.RequestScriptCompilation();
                if (AntigravityScriptEditor.ShowLogs) Debug.Log("[Antigravity] Code Optimization set to Debug Mode. Recompiling scripts...");
            }
#endif
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[Antigravity] Failed to set code optimization: {ex.Message}");
        }
    }

    private static void OnPlayModeStateChanged(PlayModeStateChange state)
    {
        if (state == PlayModeStateChange.EnteredEditMode || state == PlayModeStateChange.EnteredPlayMode)
        {
            EnsureDebugSettings();
            EvaluateBridgeState();
        }
    }

    public static void StartBridge()
    {
        lock (_lock)
        {
            if (_isRunning) return;

            EnsureDebugSettings();

            // 1. Try reusing CurrentPort first if previously assigned and valid
            if (CurrentPort >= DefaultPort && CurrentPort < DefaultPort + 100)
            {
                if (TryStartOnPort(CurrentPort))
                {
                    return;
                }
            }

            // 2. Scan ports 56000..56100 if CurrentPort was unavailable or unassigned
            int startPort = DefaultPort;
            int maxPort = startPort + 100;

            for (int port = startPort; port < maxPort; port++)
            {
                if (port == CurrentPort) continue; // Already tried
                if (TryStartOnPort(port))
                {
                    return;
                }
            }

            Debug.LogError($"[Antigravity] Failed to find available port for debug bridge in range {startPort}-{maxPort - 1}");
        }
    }

    private static bool TryStartOnPort(int port)
    {
        try
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, false);
            listener.Start();

            _listener = listener;
            CurrentPort = port;
            _isRunning = true;

            _listenerThread = new Thread(ListenForConnections)
            {
                IsBackground = true,
                Name = "AntigravityDebugBridge"
            };
            _listenerThread.Start();

            if (AntigravityScriptEditor.ShowLogs) Debug.Log($"[Antigravity] Debug bridge started on port {port}");
            WriteBridgeStateFile(port);
            GenerateDebugInfo(port);
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    public static void StopBridge(bool deleteStateFile = true)
    {
        lock (_lock)
        {
            if (!_isRunning) return;

            _isRunning = false;

            try
            {
                if (_listener != null)
                {
                    _listener.Server?.Close();
                    _listener.Stop();
                }
                _listenerThread?.Join(500);
            }
            catch (Exception)
            {
                // Ignore cleanup errors
            }
            finally
            {
                _listener = null;
                _listenerThread = null;
                if (deleteStateFile)
                {
                    DeleteBridgeStateFile();
                }
                if (AntigravityScriptEditor.ShowLogs) Debug.Log("[Antigravity] Debug bridge stopped.");
            }
        }
    }

    private static void ListenForConnections()
    {
        while (_isRunning)
        {
            try
            {
                if (_listener != null && _listener.Pending())
                {
                    var client = _listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(HandleClient, client);
                }
                else
                {
                    Thread.Sleep(100);
                }
            }
            catch (SocketException)
            {
                if (_isRunning)
                {
                    Debug.LogWarning("[Antigravity] Debug bridge listener encountered an error.");
                }
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
        }
    }

    private static void HandleClient(object state)
    {
        var client = (TcpClient)state;
        try
        {
            using (var stream = client.GetStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            using (var writer = new StreamWriter(stream, Encoding.UTF8) { AutoFlush = true })
            {
                string command;
                while (_isRunning && (command = reader.ReadLine()) != null)
                {
                    if (string.IsNullOrWhiteSpace(command)) continue;

                    string response = ProcessCommand(command);
                    LastConnectionTime = DateTime.UtcNow;
                    writer.WriteLine(response);
                }
            }
        }
        catch (Exception ex)
        {
            if (_isRunning)
            {
                if (IsNormalDisconnection(ex))
                {
                    if (AntigravityScriptEditor.ShowLogs)
                    {
                        Debug.Log("[Antigravity] Debug client disconnected.");
                    }
                }
                else
                {
                    Debug.LogWarning($"[Antigravity] Debug client error: {ex.Message}");
                }
            }
        }
        finally
        {
            client.Close();
        }
    }

    private static bool IsNormalDisconnection(Exception ex)
    {
        if (ex is SocketException se)
        {
            return IsNormalSocketError(se.SocketErrorCode);
        }

        if (ex is IOException ioe && ioe.InnerException is SocketException innerSe)
        {
            return IsNormalSocketError(innerSe.SocketErrorCode);
        }

        if (ex is ObjectDisposedException)
        {
            return true;
        }

        return false;
    }

    private static bool IsNormalSocketError(SocketError errorCode)
    {
        return errorCode == SocketError.ConnectionReset ||
               errorCode == SocketError.ConnectionAborted ||
               errorCode == SocketError.OperationAborted ||
               errorCode == SocketError.Shutdown ||
               errorCode == SocketError.Interrupted ||
               errorCode == SocketError.NotConnected;
    }

    private static string ProcessCommand(string command)
    {
        try
        {
            // Simple JSON-based command protocol
            if (command.Contains("\"type\":\"ping\""))
            {
                return "{\"type\":\"pong\",\"status\":\"ok\"}";
            }
            else if (command.Contains("\"type\":\"info\""))
            {
                return GetDebugInfoJson();
            }
            else if (command.Contains("\"type\":\"pause\""))
            {
                EditorApplication.delayCall += () => EditorApplication.isPaused = true;
                return "{\"type\":\"response\",\"status\":\"paused\"}";
            }
            else if (command.Contains("\"type\":\"resume\""))
            {
                EditorApplication.delayCall += () => EditorApplication.isPaused = false;
                return "{\"type\":\"response\",\"status\":\"resumed\"}";
            }
            else if (command.Contains("\"type\":\"play\""))
            {
                EditorApplication.delayCall += () => EditorApplication.isPlaying = true;
                return "{\"type\":\"response\",\"status\":\"playing\"}";
            }
            else if (command.Contains("\"type\":\"stop\""))
            {
                EditorApplication.delayCall += () => EditorApplication.isPlaying = false;
                return "{\"type\":\"response\",\"status\":\"stopped\"}";
            }
            else if (command.Contains("\"type\":\"get_serialized_values\""))
            {
                string classPath = ExtractJsonValue(command, "class_path");
                string fieldsStr = ExtractJsonValue(command, "fields");
                if (string.IsNullOrEmpty(classPath))
                {
                    return "{\"type\":\"error\",\"message\":\"missing class_path\"}";
                }
                return GetSerializedValuesJson(classPath, fieldsStr);
            }
            else if (command.Contains("\"type\":\"find_usages\""))
            {
                string classPath = ExtractJsonValue(command, "class_path");
                if (string.IsNullOrEmpty(classPath))
                {
                    return "{\"type\":\"error\",\"message\":\"missing class_path\"}";
                }
                string className = Path.GetFileNameWithoutExtension(classPath);
                string jsonResult = FindUsagesOfClass(classPath, out List<string> usagesList);

                // Schedule opening the AssetUsagesWindow in Unity on the main thread
                EditorApplication.delayCall += () => {
                    AssetUsagesWindow.ShowWindow(className, usagesList);
                };

                return jsonResult;
            }
            else if (command.Contains("\"type\":\"ping_asset\""))
            {
#if UNITY_6000_0_OR_NEWER
                ulong? localId = ExtractJsonULongValue(command, "local_id");
#else
                int? localId = ExtractJsonIntValue(command, "local_id");
#endif
                string assetPath = ExtractJsonValue(command, "asset_path");
                if (!localId.HasValue && string.IsNullOrEmpty(assetPath))
                {
                    return "{\"type\":\"error\",\"message\":\"missing local_id and asset_path\"}";
                }

                EditorApplication.delayCall += () => {
                    UnityEngine.Object obj = null;
                    if (localId.HasValue)
                    {
#if UNITY_6000_0_OR_NEWER
                        obj = EditorUtility.EntityIdToObject(EntityId.FromULong(localId.Value));
#else
                        obj = EditorUtility.InstanceIDToObject(localId.Value);
#endif
                    }
                    if (obj == null && !string.IsNullOrEmpty(assetPath))
                    {
                        obj = AssetDatabase.LoadMainAssetAtPath(assetPath);
                    }

                    if (obj != null)
                    {
                        Selection.activeObject = obj;
                        EditorGUIUtility.PingObject(obj);
                        if (obj is GameObject || obj is Component)
                        {
                            EditorApplication.ExecuteMenuItem("Window/General/Hierarchy");
                        }
                        else
                        {
                            EditorUtility.FocusProjectWindow();
                        }
                    }
                };
                return "{\"type\":\"response\",\"status\":\"pinged\"}";
            }
            else if (command.Contains("\"type\":\"open_asset\""))
            {
#if UNITY_6000_0_OR_NEWER
                ulong? localId = ExtractJsonULongValue(command, "local_id");
#else
                int? localId = ExtractJsonIntValue(command, "local_id");
#endif
                string assetPath = ExtractJsonValue(command, "asset_path");
                if (!localId.HasValue && string.IsNullOrEmpty(assetPath))
                {
                    return "{\"type\":\"error\",\"message\":\"missing local_id and asset_path\"}";
                }

                EditorApplication.delayCall += () => {
                    UnityEngine.Object obj = null;
                    if (localId.HasValue)
                    {
#if UNITY_6000_0_OR_NEWER
                        obj = EditorUtility.EntityIdToObject(EntityId.FromULong(localId.Value));
#else
                        obj = EditorUtility.InstanceIDToObject(localId.Value);
#endif
                    }
                    if (obj == null && !string.IsNullOrEmpty(assetPath))
                    {
                        obj = AssetDatabase.LoadMainAssetAtPath(assetPath);
                    }

                    if (obj != null)
                    {
                        if (assetPath != null && assetPath.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
                        {
                            if (UnityEditor.SceneManagement.EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())
                            {
                                UnityEditor.SceneManagement.EditorSceneManager.OpenScene(assetPath);
                            }
                        }
                        else
                        {
                            AssetDatabase.OpenAsset(obj);
                        }
                        Selection.activeObject = obj;
                        EditorGUIUtility.PingObject(obj);
                        if (obj is GameObject || obj is Component)
                        {
                            EditorApplication.ExecuteMenuItem("Window/General/Hierarchy");
                        }
                        else
                        {
                            EditorUtility.FocusProjectWindow();
                        }
                    }
                };
                return "{\"type\":\"response\",\"status\":\"opened\"}";
            }
            else
            {
                return "{\"type\":\"error\",\"message\":\"unknown command\"}";
            }
        }
        catch (Exception ex)
        {
            return $"{{\"type\":\"error\",\"message\":\"{ex.Message.Replace("\"", "\\\"")}\"}}";
        }
    }

    private static string ExtractJsonValue(string json, string key)
    {
        string pattern = $"\"{key}\"\\s*:\\s*\"([^\"]+)\"";
        var match = System.Text.RegularExpressions.Regex.Match(json, pattern);
        return match.Success ? match.Groups[1].Value : null;
    }

    private static int? ExtractJsonIntValue(string json, string key)
    {
        string pattern = $"\"{key}\"\\s*:\\s*([0-9-]+)";
        var match = System.Text.RegularExpressions.Regex.Match(json, pattern);
        if (match.Success && int.TryParse(match.Groups[1].Value, out int result))
        {
            return result;
        }
        return null;
    }

    private static ulong? ExtractJsonULongValue(string json, string key)
    {
        string pattern = $"\"{key}\"\\s*:\\s*([0-9-]+)";
        var match = System.Text.RegularExpressions.Regex.Match(json, pattern);
        if (match.Success)
        {
            if (ulong.TryParse(match.Groups[1].Value, out ulong uResult))
            {
                return uResult;
            }
            if (long.TryParse(match.Groups[1].Value, out long lResult))
            {
                return (ulong)lResult;
            }
        }
        return null;
    }

    private static string GetSerializedValuesJson(string classPath, string fieldsStr)
    {
        string className = Path.GetFileNameWithoutExtension(classPath);
        var fields = new List<string>();
        if (!string.IsNullOrEmpty(fieldsStr))
        {
            fields.AddRange(fieldsStr.Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries));
        }

        // Check if we are already on the main thread (avoids deadlocks)
        // System.Threading.Thread.CurrentThread or using EditorApplication checks
        // Since ProcessCommand runs on a ThreadPool thread (HandleClient), we usually synchronize.
        // But if called directly from main thread (e.g., during tests), execute synchronously.
        if (System.Threading.Thread.CurrentThread.ManagedThreadId == 1)
        {
            try
            {
                return ScrapeSerializedValues(classPath, className, fields);
            }
            catch (Exception ex)
            {
                return $"{{\"type\":\"error\",\"message\":\"{ex.Message.Replace("\"", "\\\"")}\"}}";
            }
        }

        var resultJson = new StringBuilder();
        var isDone = false;

        EditorApplication.delayCall += () =>
        {
            try
            {
                resultJson.Append(ScrapeSerializedValues(classPath, className, fields));
            }
            catch (Exception ex)
            {
                resultJson.Append($"{{\"type\":\"error\",\"message\":\"{ex.Message.Replace("\"", "\\\"")}\"}}");
            }
            finally
            {
                isDone = true;
            }
        };

        // Wait up to 2 seconds for main thread execution to finish
        int elapsed = 0;
        while (!isDone && elapsed < 2000)
        {
            Thread.Sleep(10);
            elapsed += 10;
        }

        if (!isDone)
        {
            return "{\"type\":\"error\",\"message\":\"timeout waiting for Unity main thread\"}";
        }

        return resultJson.ToString();
    }

    private static string ScrapeSerializedValues(string classPath, string className, List<string> fields)
    {
        // Find type of class
        Type type = null;
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            type = assembly.GetType(className);
            if (type != null) break;
        }

        if (type == null)
        {
            // Fallback: try finding via TypeCache or script compilation
            type = TypeCache.GetTypesDerivedFrom<MonoBehaviour>()
                .FirstOrDefault(t => t.Name == className);
        }

        if (type == null)
        {
            return $"{{\"type\":\"serialized_values_result\",\"class_path\":\"{classPath}\",\"values\":{{}}}}";
        }

        // Scrape active scenes for GameObjects containing this MonoBehaviour
        var resultsByField = new Dictionary<string, List<string>>();
        foreach (var f in fields)
        {
            resultsByField[f] = new List<string>();
        }

        // Search active scenes (Primary Scope - loaded & active scenes)
        int sceneCount = UnityEngine.SceneManagement.SceneManager.sceneCount;
        for (int i = 0; i < sceneCount; i++)
        {
            var scene = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);
            if (!scene.isLoaded) continue;

            string scenePath = scene.path;
            var rootGos = scene.GetRootGameObjects();
            foreach (var rootGo in rootGos)
            {
                var components = rootGo.GetComponentsInChildren(type, true);
                foreach (var comp in components)
                {
                    if (comp == null) continue;

                    var so = new SerializedObject(comp);
                    foreach (var fieldName in fields)
                    {
                        var prop = so.FindProperty(fieldName);
                        if (prop == null) continue;

                        string displayVal = GetPropertyValueString(prop);
#if UNITY_6000_0_OR_NEWER
                        ulong instanceId = EntityId.ToULong(comp.gameObject.GetEntityId());
#else
                        int instanceId = comp.gameObject.GetInstanceID();
#endif
                        string containerName = comp.gameObject.name;

                        string entryJson = $"{{\"container\":\"{containerName.Replace("\"", "\\\"")}\",\"value\":\"{displayVal.Replace("\"", "\\\"")}\",\"asset_path\":\"{scenePath.Replace("\\", "/")}\",\"local_id\":{instanceId},\"is_scene\":true}}";
                        resultsByField[fieldName].Add(entryJson);
                    }
                }
            }
        }

        // Secondary Scope (Async/Fast Prefabs and non-active scenes):
        // To prevent editor freeze, do NOT synchronously scan/load every prefab in the project asset tree.
        // Instead, only look for currently loaded/cached prefab assets or lightweight memory mappings.
        // We can safely find prefabs that are currently selected or active, or loaded in memory,
        // without loading thousands of assets from disk.
        try
        {
            var loadedAssets = Resources.FindObjectsOfTypeAll(type);
            foreach (var compObj in loadedAssets)
            {
                var comp = compObj as MonoBehaviour;
                if (comp == null) continue;

                // Only grab components that are on prefabs (i.e. not in a scene)
                if (comp.gameObject.scene.name != null) continue;

                string path = AssetDatabase.GetAssetPath(comp.gameObject);
                if (string.IsNullOrEmpty(path)) continue;

                var so = new SerializedObject(comp);
                foreach (var fieldName in fields)
                {
                    var prop = so.FindProperty(fieldName);
                    if (prop == null) continue;

                    string displayVal = GetPropertyValueString(prop);
#if UNITY_6000_0_OR_NEWER
                    ulong instanceId = EntityId.ToULong(comp.gameObject.GetEntityId());
#else
                    int instanceId = comp.gameObject.GetInstanceID();
#endif
                    string containerName = comp.gameObject.name;

                    string entryJson = $"{{\"container\":\"{containerName.Replace("\"", "\\\"")}\",\"value\":\"{displayVal.Replace("\"", "\\\"")}\",\"asset_path\":\"{path.Replace("\\", "/")}\",\"local_id\":{instanceId},\"is_scene\":false}}";

                    // Avoid duplicates
                    if (!resultsByField[fieldName].Exists(x => x.Contains($"\"local_id\":{instanceId}")))
                    {
                        resultsByField[fieldName].Add(entryJson);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[Antigravity] Prefab values scraping warning: {ex.Message}");
        }

        // Build overall JSON output
        var sb = new StringBuilder();
        sb.Append($"{{\"type\":\"serialized_values_result\",\"class_path\":\"{classPath}\",\"values\":{{");
        bool firstField = true;
        foreach (var pair in resultsByField)
        {
            if (!firstField) sb.Append(",");
            firstField = false;

            sb.Append($"\"{pair.Key}\":[");
            for (int j = 0; j < pair.Value.Count; j++)
            {
                sb.Append(pair.Value[j]);
                if (j < pair.Value.Count - 1) sb.Append(",");
            }
            sb.Append("]");
        }
        sb.Append("}}");

        return sb.ToString();
    }

    private static string GetPropertyValueString(SerializedProperty prop)
    {
        switch (prop.propertyType)
        {
            case SerializedPropertyType.Integer:
                return prop.intValue.ToString();
            case SerializedPropertyType.Boolean:
                return prop.boolValue ? "true" : "false";
            case SerializedPropertyType.Float:
                return prop.floatValue.ToString("F2");
            case SerializedPropertyType.String:
                return prop.stringValue;
            case SerializedPropertyType.Color:
                return prop.colorValue.ToString();
            case SerializedPropertyType.ObjectReference:
                if (prop.objectReferenceValue != null)
                {
                    return prop.objectReferenceValue.name;
                }
                return "None";
            case SerializedPropertyType.Vector2:
                return prop.vector2Value.ToString();
            case SerializedPropertyType.Vector3:
                return prop.vector3Value.ToString();
            case SerializedPropertyType.Rect:
                return prop.rectValue.ToString();
            case SerializedPropertyType.Character:
                return ((char)prop.intValue).ToString();
            case SerializedPropertyType.AnimationCurve:
                return "Curve";
            case SerializedPropertyType.Bounds:
                return prop.boundsValue.ToString();
            case SerializedPropertyType.Enum:
                if (prop.enumValueIndex >= 0 && prop.enumValueIndex < prop.enumDisplayNames.Length)
                {
                    return prop.enumDisplayNames[prop.enumValueIndex];
                }
                return prop.enumValueIndex.ToString();
            default:
                return "...";
        }
    }

    private static string FindUsagesOfClass(string classPath, out List<string> usagesList)
    {
        usagesList = new List<string>();
        try
        {
            string guidValue = null;
            string metaPath = classPath + ".meta";

            if (File.Exists(metaPath))
            {
                foreach (var line in File.ReadAllLines(metaPath))
                {
                    if (line.Trim().StartsWith("guid:"))
                    {
                        guidValue = line.Substring(line.IndexOf("guid:") + 5).Trim();
                        break;
                    }
                }
            }

            if (string.IsNullOrEmpty(guidValue))
            {
                return "{\"type\":\"usages_result\",\"usages\":[]}";
            }

            return ScanProjectForGuid(guidValue, out usagesList);
        }
        catch (Exception ex)
        {
            return $"{{\"type\":\"error\",\"message\":\"{ex.Message.Replace("\"", "\\\"")}\"}}";
        }
    }

    private static string ScanProjectForGuid(string guid, out List<string> usages)
    {
        usages = new List<string>();
        string projectDir = Directory.GetCurrentDirectory();
        string assetsDir = Path.Combine(projectDir, "Assets");

        if (!Directory.Exists(assetsDir))
        {
            return "{\"type\":\"usages_result\",\"usages\":[]}";
        }

        string[] extensions = { "*.prefab", "*.unity", "*.asset", "*.controller", "*.anim", "*.overrideController", "*.mat", "*.playable" };
        var candidateFiles = new List<string>();

        foreach (var ext in extensions)
        {
            try
            {
                candidateFiles.AddRange(Directory.GetFiles(assetsDir, ext, SearchOption.AllDirectories));
            }
            catch { }
        }

        foreach (var file in candidateFiles)
        {
            try
            {
                string content = File.ReadAllText(file);
                if (content.Contains(guid))
                {
                    string relativePath = file.Replace("\\", "/");
                    int assetsIndex = relativePath.IndexOf("Assets/", StringComparison.OrdinalIgnoreCase);
                    if (assetsIndex >= 0)
                    {
                        relativePath = relativePath.Substring(assetsIndex);
                    }
                    usages.Add(relativePath);
                }
            }
            catch { }
        }

        var sb = new StringBuilder();
        int pid = System.Diagnostics.Process.GetCurrentProcess().Id;
        sb.Append("{\"type\":\"usages_result\",\"process_id\":");
        sb.Append(pid);
        sb.Append(",\"usages\":[");
        for (int i = 0; i < usages.Count; i++)
        {
            sb.Append($"\"{usages[i].Replace("\\", "/")}\"");
            if (i < usages.Count - 1) sb.Append(",");
        }
        sb.Append("]}");

        return sb.ToString();
    }

    private static string GetDebugInfoJson()
    {
        // Uses cached main-thread values — safe to call from background ThreadPool threads
        int monoDebuggerPort = GetMonoDebuggerPort();
        return $"{{" +
               $"\"type\":\"debug_info\"," +
               $"\"unity_version\":\"{EscapeJson(_cachedUnityVersion)}\"," +
               $"\"project_name\":\"{EscapeJson(_cachedProjectName)}\"," +
               $"\"project_path\":\"{EscapeJson(_cachedProjectPath)}\"," +
               $"\"mono_debugger_port\":{monoDebuggerPort}," +
               $"\"script_debugging_enabled\":{(_cachedScriptDebugging ? "true" : "false")}," +
               $"\"is_playing\":{(_cachedIsPlaying ? "true" : "false")}," +
               $"\"is_paused\":{(_cachedIsPaused ? "true" : "false")}," +
               $"\"process_id\":{_cachedProcessId}" +
               $"}}";
    }

    private static int GetMonoDebuggerPort()
    {
        // Unity's Mono debugger typically listens on port 56000 + offset
        // The actual port can be found in the EditorUserBuildSettings
        try
        {
            string projectDir = Directory.GetCurrentDirectory();
            string debugInfoPath = Path.Combine(projectDir, "Library", "EditorInstance.json");

            if (File.Exists(debugInfoPath))
            {
                string content = File.ReadAllText(debugInfoPath);
                // Simple parsing for process_id to help locate debugger port
                // The actual Mono debugger port is determined at runtime
            }
        }
        catch (Exception)
        {
            // Fallback
        }

        return 56000;
    }

    private static void GenerateDebugInfo(int bridgePort)
    {
        string projectDir = Directory.GetCurrentDirectory();
        string vscodeDir = Path.Combine(projectDir, ".vscode");

        if (!Directory.Exists(vscodeDir))
        {
            Directory.CreateDirectory(vscodeDir);
        }

        // Generate launch.json using DotRush's "unity" debugger type
        // EditorInstance.json path is used by vscode-unity-debug pattern for multi-instance discovery
        string editorInstancePath = "${workspaceFolder}/Library/EditorInstance.json";
        string launchPath = Path.Combine(vscodeDir, "launch.json");
        string launchContent = $@"{{
    ""version"": ""0.2.0"",
    ""configurations"": [
        {{
            ""name"": ""Attach to Unity Editor"",
            ""type"": ""unity"",
            ""request"": ""attach"",
            ""path"": ""{editorInstancePath}""
        }},
        {{
            ""name"": ""Attach to Unity Player"",
            ""type"": ""unity"",
            ""request"": ""attach"",
            ""transportArgs"": {{
                ""port"": {bridgePort}
            }}
        }}
    ]
}}";
        File.WriteAllText(launchPath, launchContent);
    }
}
