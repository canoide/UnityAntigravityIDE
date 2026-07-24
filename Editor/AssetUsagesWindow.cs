using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

/// <summary>
/// Unity Editor window for displaying asset usages categorized by Scenes, Prefabs,
/// Scriptable Objects, Animators, Animations, and other assets.
/// Window focus and OS un-minimizing is handled by the Antigravity IDE extension
/// using the Unity process ID obtained from the debug bridge.
/// </summary>
public class AssetUsagesWindow : EditorWindow
{
    private string m_TargetClassName = "";
    private string m_SearchFilter = "";
    private Vector2 m_ScrollPosition;
    private string m_SelectedAssetPath = "";

    private Dictionary<string, List<string>> m_CategorizedUsages = new Dictionary<string, List<string>>();
    private Dictionary<string, bool> m_CategoryFoldouts = new Dictionary<string, bool>();

    public static void ShowWindow(string targetClassName, List<string> usagePaths)
    {
        var window = GetWindow<AssetUsagesWindow>("Asset Usages");
        window.minSize = new Vector2(420, 320);
        window.SetData(targetClassName, usagePaths);
        window.Show();
        window.Focus();
    }

    public void SetData(string targetClassName, List<string> usagePaths)
    {
        m_TargetClassName = targetClassName;
        m_CategorizedUsages.Clear();
        m_CategoryFoldouts.Clear();

        m_CategorizedUsages["Scenes"] = new List<string>();
        m_CategorizedUsages["Prefabs"] = new List<string>();
        m_CategorizedUsages["Scriptable Objects"] = new List<string>();
        m_CategorizedUsages["Animators"] = new List<string>();
        m_CategorizedUsages["Animations"] = new List<string>();
        m_CategorizedUsages["Others"] = new List<string>();

        if (usagePaths != null)
        {
            foreach (var path in usagePaths)
            {
                string ext = Path.GetExtension(path).ToLowerInvariant();
                if (ext == ".unity")
                    m_CategorizedUsages["Scenes"].Add(path);
                else if (ext == ".prefab")
                    m_CategorizedUsages["Prefabs"].Add(path);
                else if (ext == ".controller" || ext == ".overridecontroller")
                    m_CategorizedUsages["Animators"].Add(path);
                else if (ext == ".anim")
                    m_CategorizedUsages["Animations"].Add(path);
                else if (ext == ".asset")
                    m_CategorizedUsages["Scriptable Objects"].Add(path);
                else
                    m_CategorizedUsages["Others"].Add(path);
            }
        }

        foreach (var key in m_CategorizedUsages.Keys.ToList())
        {
            m_CategoryFoldouts[key] = true;
        }

        Repaint();
    }

    private void OnGUI()
    {
        EditorGUILayout.Space(6);

        // Header toolbar
        EditorGUILayout.BeginHorizontal(EditorStyles.toolbar);
        GUILayout.Label(string.IsNullOrEmpty(m_TargetClassName)
            ? "Asset Usages"
            : $"Asset Usages for: {m_TargetClassName}", EditorStyles.boldLabel);
        GUILayout.FlexibleSpace();
        int totalUsages = m_CategorizedUsages.Values.Sum(list => list.Count);
        GUILayout.Label($"Total: {totalUsages}", EditorStyles.miniLabel);
        EditorGUILayout.EndHorizontal();

        EditorGUILayout.Space(4);

        // Search filter
        m_SearchFilter = EditorGUILayout.TextField("Filter Assets", m_SearchFilter, "SearchTextField");

        EditorGUILayout.Space(4);

        if (totalUsages == 0)
        {
            EditorGUILayout.HelpBox("No asset usages found in the project for this class.", MessageType.Info);
            return;
        }

        m_ScrollPosition = EditorGUILayout.BeginScrollView(m_ScrollPosition);

        foreach (var category in m_CategorizedUsages.Keys.ToList())
        {
            var items = m_CategorizedUsages[category];
            if (!string.IsNullOrEmpty(m_SearchFilter))
            {
                items = items.Where(i => i.IndexOf(m_SearchFilter, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
            }

            if (items.Count == 0) continue;

            bool foldout = m_CategoryFoldouts.ContainsKey(category) ? m_CategoryFoldouts[category] : true;
            string foldoutTitle = $"{category} ({items.Count})";

            EditorGUILayout.BeginVertical(EditorStyles.helpBox);
            m_CategoryFoldouts[category] = EditorGUILayout.Foldout(foldout, foldoutTitle, true, EditorStyles.foldoutHeader);

            if (m_CategoryFoldouts[category])
            {
                EditorGUI.indentLevel++;
                foreach (var itemPath in items)
                {
                    DrawAssetRow(itemPath);
                }
                EditorGUI.indentLevel--;
            }
            EditorGUILayout.EndVertical();
            EditorGUILayout.Space(2);
        }

        EditorGUILayout.EndScrollView();
    }

    private void DrawAssetRow(string assetPath)
    {
        Rect rowRect = EditorGUILayout.BeginHorizontal(GUILayout.Height(24));

        bool isSelected = (m_SelectedAssetPath == assetPath);

        // Hover and selection background
        if (Event.current.type == EventType.Repaint)
        {
            if (isSelected)
            {
                EditorGUI.DrawRect(rowRect, new Color(0.24f, 0.48f, 0.90f, 0.35f));
            }
            else if (rowRect.Contains(Event.current.mousePosition))
            {
                EditorGUI.DrawRect(rowRect, new Color(1f, 1f, 1f, 0.05f));
            }
        }

        var obj = AssetDatabase.LoadMainAssetAtPath(assetPath);
        GUIContent content = EditorGUIUtility.ObjectContent(obj, obj != null ? obj.GetType() : typeof(UnityEngine.Object));
        content.text = Path.GetFileName(assetPath);
        content.tooltip = assetPath;

        GUILayout.Space(4);
        GUILayout.Label(content, GUILayout.Height(20));

        GUILayout.FlexibleSpace();

        // Open button
        if (GUILayout.Button("Open", EditorStyles.miniButton, GUILayout.Width(45)))
        {
            OpenAssetPath(assetPath, obj);
        }

        EditorGUILayout.EndHorizontal();

        // Single click: select and ping. Double click: open.
        if (Event.current.type == EventType.MouseDown && rowRect.Contains(Event.current.mousePosition))
        {
            m_SelectedAssetPath = assetPath;

            if (obj != null)
            {
                Selection.activeObject = obj;
                EditorGUIUtility.PingObject(obj);
                EditorUtility.FocusProjectWindow();
            }

            if (Event.current.clickCount == 2)
            {
                OpenAssetPath(assetPath, obj);
            }

            Event.current.Use();
            Repaint();
        }
    }

    private static void OpenAssetPath(string assetPath, UnityEngine.Object obj)
    {
        if (obj == null) return;

        if (assetPath.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
        {
            if (EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())
            {
                EditorSceneManager.OpenScene(assetPath);
            }
        }
        else
        {
            AssetDatabase.OpenAsset(obj);
        }

        Selection.activeObject = obj;
        EditorGUIUtility.PingObject(obj);
        EditorUtility.FocusProjectWindow();
    }
}
