// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

// node_modules/fast-xml-parser/src/util.js
var require_util = __commonJS((exports) => {
  var nameStartChar = ":A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD";
  var nameChar = nameStartChar + "\\-.\\d\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
  var nameRegexp = "[" + nameStartChar + "][" + nameChar + "]*";
  var regexName = new RegExp("^" + nameRegexp + "$");
  var getAllMatches = function(string, regex) {
    const matches = [];
    let match = regex.exec(string);
    while (match) {
      const allmatches = [];
      allmatches.startIndex = regex.lastIndex - match[0].length;
      const len = match.length;
      for (let index = 0;index < len; index++) {
        allmatches.push(match[index]);
      }
      matches.push(allmatches);
      match = regex.exec(string);
    }
    return matches;
  };
  var isName = function(string) {
    const match = regexName.exec(string);
    return !(match === null || typeof match === "undefined");
  };
  exports.isExist = function(v) {
    return typeof v !== "undefined";
  };
  exports.isEmptyObject = function(obj) {
    return Object.keys(obj).length === 0;
  };
  exports.merge = function(target, a, arrayMode) {
    if (a) {
      const keys = Object.keys(a);
      const len = keys.length;
      for (let i = 0;i < len; i++) {
        if (arrayMode === "strict") {
          target[keys[i]] = [a[keys[i]]];
        } else {
          target[keys[i]] = a[keys[i]];
        }
      }
    }
  };
  exports.getValue = function(v) {
    if (exports.isExist(v)) {
      return v;
    } else {
      return "";
    }
  };
  var DANGEROUS_PROPERTY_NAMES = [
    "hasOwnProperty",
    "toString",
    "valueOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__"
  ];
  var criticalProperties = ["__proto__", "constructor", "prototype"];
  exports.isName = isName;
  exports.getAllMatches = getAllMatches;
  exports.nameRegexp = nameRegexp;
  exports.DANGEROUS_PROPERTY_NAMES = DANGEROUS_PROPERTY_NAMES;
  exports.criticalProperties = criticalProperties;
});

// node_modules/fast-xml-parser/src/validator.js
var require_validator = __commonJS((exports) => {
  var util = require_util();
  var defaultOptions = {
    allowBooleanAttributes: false,
    unpairedTags: []
  };
  exports.validate = function(xmlData, options) {
    options = Object.assign({}, defaultOptions, options);
    const tags = [];
    let tagFound = false;
    let reachedRoot = false;
    if (xmlData[0] === "\uFEFF") {
      xmlData = xmlData.substr(1);
    }
    for (let i = 0;i < xmlData.length; i++) {
      if (xmlData[i] === "<" && xmlData[i + 1] === "?") {
        i += 2;
        i = readPI(xmlData, i);
        if (i.err)
          return i;
      } else if (xmlData[i] === "<") {
        let tagStartPos = i;
        i++;
        if (xmlData[i] === "!") {
          i = readCommentAndCDATA(xmlData, i);
          continue;
        } else {
          let closingTag = false;
          if (xmlData[i] === "/") {
            closingTag = true;
            i++;
          }
          let tagName = "";
          for (;i < xmlData.length && xmlData[i] !== ">" && xmlData[i] !== " " && xmlData[i] !== "\t" && xmlData[i] !== `
` && xmlData[i] !== "\r"; i++) {
            tagName += xmlData[i];
          }
          tagName = tagName.trim();
          if (tagName[tagName.length - 1] === "/") {
            tagName = tagName.substring(0, tagName.length - 1);
            i--;
          }
          if (!validateTagName(tagName)) {
            let msg;
            if (tagName.trim().length === 0) {
              msg = "Invalid space after '<'.";
            } else {
              msg = "Tag '" + tagName + "' is an invalid name.";
            }
            return getErrorObject("InvalidTag", msg, getLineNumberForPosition(xmlData, i));
          }
          const result = readAttributeStr(xmlData, i);
          if (result === false) {
            return getErrorObject("InvalidAttr", "Attributes for '" + tagName + "' have open quote.", getLineNumberForPosition(xmlData, i));
          }
          let attrStr = result.value;
          i = result.index;
          if (attrStr[attrStr.length - 1] === "/") {
            const attrStrStart = i - attrStr.length;
            attrStr = attrStr.substring(0, attrStr.length - 1);
            const isValid = validateAttributeString(attrStr, options);
            if (isValid === true) {
              tagFound = true;
            } else {
              return getErrorObject(isValid.err.code, isValid.err.msg, getLineNumberForPosition(xmlData, attrStrStart + isValid.err.line));
            }
          } else if (closingTag) {
            if (!result.tagClosed) {
              return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' doesn't have proper closing.", getLineNumberForPosition(xmlData, i));
            } else if (attrStr.trim().length > 0) {
              return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' can't have attributes or invalid starting.", getLineNumberForPosition(xmlData, tagStartPos));
            } else if (tags.length === 0) {
              return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' has not been opened.", getLineNumberForPosition(xmlData, tagStartPos));
            } else {
              const otg = tags.pop();
              if (tagName !== otg.tagName) {
                let openPos = getLineNumberForPosition(xmlData, otg.tagStartPos);
                return getErrorObject("InvalidTag", "Expected closing tag '" + otg.tagName + "' (opened in line " + openPos.line + ", col " + openPos.col + ") instead of closing tag '" + tagName + "'.", getLineNumberForPosition(xmlData, tagStartPos));
              }
              if (tags.length == 0) {
                reachedRoot = true;
              }
            }
          } else {
            const isValid = validateAttributeString(attrStr, options);
            if (isValid !== true) {
              return getErrorObject(isValid.err.code, isValid.err.msg, getLineNumberForPosition(xmlData, i - attrStr.length + isValid.err.line));
            }
            if (reachedRoot === true) {
              return getErrorObject("InvalidXml", "Multiple possible root nodes found.", getLineNumberForPosition(xmlData, i));
            } else if (options.unpairedTags.indexOf(tagName) !== -1) {} else {
              tags.push({ tagName, tagStartPos });
            }
            tagFound = true;
          }
          for (i++;i < xmlData.length; i++) {
            if (xmlData[i] === "<") {
              if (xmlData[i + 1] === "!") {
                i++;
                i = readCommentAndCDATA(xmlData, i);
                continue;
              } else if (xmlData[i + 1] === "?") {
                i = readPI(xmlData, ++i);
                if (i.err)
                  return i;
              } else {
                break;
              }
            } else if (xmlData[i] === "&") {
              const afterAmp = validateAmpersand(xmlData, i);
              if (afterAmp == -1)
                return getErrorObject("InvalidChar", "char '&' is not expected.", getLineNumberForPosition(xmlData, i));
              i = afterAmp;
            } else {
              if (reachedRoot === true && !isWhiteSpace(xmlData[i])) {
                return getErrorObject("InvalidXml", "Extra text at the end", getLineNumberForPosition(xmlData, i));
              }
            }
          }
          if (xmlData[i] === "<") {
            i--;
          }
        }
      } else {
        if (isWhiteSpace(xmlData[i])) {
          continue;
        }
        return getErrorObject("InvalidChar", "char '" + xmlData[i] + "' is not expected.", getLineNumberForPosition(xmlData, i));
      }
    }
    if (!tagFound) {
      return getErrorObject("InvalidXml", "Start tag expected.", 1);
    } else if (tags.length == 1) {
      return getErrorObject("InvalidTag", "Unclosed tag '" + tags[0].tagName + "'.", getLineNumberForPosition(xmlData, tags[0].tagStartPos));
    } else if (tags.length > 0) {
      return getErrorObject("InvalidXml", "Invalid '" + JSON.stringify(tags.map((t) => t.tagName), null, 4).replace(/\r?\n/g, "") + "' found.", { line: 1, col: 1 });
    }
    return true;
  };
  function isWhiteSpace(char) {
    return char === " " || char === "\t" || char === `
` || char === "\r";
  }
  function readPI(xmlData, i) {
    const start = i;
    for (;i < xmlData.length; i++) {
      if (xmlData[i] == "?" || xmlData[i] == " ") {
        const tagname = xmlData.substr(start, i - start);
        if (i > 5 && tagname === "xml") {
          return getErrorObject("InvalidXml", "XML declaration allowed only at the start of the document.", getLineNumberForPosition(xmlData, i));
        } else if (xmlData[i] == "?" && xmlData[i + 1] == ">") {
          i++;
          break;
        } else {
          continue;
        }
      }
    }
    return i;
  }
  function readCommentAndCDATA(xmlData, i) {
    if (xmlData.length > i + 5 && xmlData[i + 1] === "-" && xmlData[i + 2] === "-") {
      for (i += 3;i < xmlData.length; i++) {
        if (xmlData[i] === "-" && xmlData[i + 1] === "-" && xmlData[i + 2] === ">") {
          i += 2;
          break;
        }
      }
    } else if (xmlData.length > i + 8 && xmlData[i + 1] === "D" && xmlData[i + 2] === "O" && xmlData[i + 3] === "C" && xmlData[i + 4] === "T" && xmlData[i + 5] === "Y" && xmlData[i + 6] === "P" && xmlData[i + 7] === "E") {
      let angleBracketsCount = 1;
      for (i += 8;i < xmlData.length; i++) {
        if (xmlData[i] === "<") {
          angleBracketsCount++;
        } else if (xmlData[i] === ">") {
          angleBracketsCount--;
          if (angleBracketsCount === 0) {
            break;
          }
        }
      }
    } else if (xmlData.length > i + 9 && xmlData[i + 1] === "[" && xmlData[i + 2] === "C" && xmlData[i + 3] === "D" && xmlData[i + 4] === "A" && xmlData[i + 5] === "T" && xmlData[i + 6] === "A" && xmlData[i + 7] === "[") {
      for (i += 8;i < xmlData.length; i++) {
        if (xmlData[i] === "]" && xmlData[i + 1] === "]" && xmlData[i + 2] === ">") {
          i += 2;
          break;
        }
      }
    }
    return i;
  }
  var doubleQuote = '"';
  var singleQuote = "'";
  function readAttributeStr(xmlData, i) {
    let attrStr = "";
    let startChar = "";
    let tagClosed = false;
    for (;i < xmlData.length; i++) {
      if (xmlData[i] === doubleQuote || xmlData[i] === singleQuote) {
        if (startChar === "") {
          startChar = xmlData[i];
        } else if (startChar !== xmlData[i]) {} else {
          startChar = "";
        }
      } else if (xmlData[i] === ">") {
        if (startChar === "") {
          tagClosed = true;
          break;
        }
      }
      attrStr += xmlData[i];
    }
    if (startChar !== "") {
      return false;
    }
    return {
      value: attrStr,
      index: i,
      tagClosed
    };
  }
  var validAttrStrRegxp = new RegExp(`(\\s*)([^\\s=]+)(\\s*=)?(\\s*(['"])(([\\s\\S])*?)\\5)?`, "g");
  function validateAttributeString(attrStr, options) {
    const matches = util.getAllMatches(attrStr, validAttrStrRegxp);
    const attrNames = {};
    for (let i = 0;i < matches.length; i++) {
      if (matches[i][1].length === 0) {
        return getErrorObject("InvalidAttr", "Attribute '" + matches[i][2] + "' has no space in starting.", getPositionFromMatch(matches[i]));
      } else if (matches[i][3] !== undefined && matches[i][4] === undefined) {
        return getErrorObject("InvalidAttr", "Attribute '" + matches[i][2] + "' is without value.", getPositionFromMatch(matches[i]));
      } else if (matches[i][3] === undefined && !options.allowBooleanAttributes) {
        return getErrorObject("InvalidAttr", "boolean attribute '" + matches[i][2] + "' is not allowed.", getPositionFromMatch(matches[i]));
      }
      const attrName = matches[i][2];
      if (!validateAttrName(attrName)) {
        return getErrorObject("InvalidAttr", "Attribute '" + attrName + "' is an invalid name.", getPositionFromMatch(matches[i]));
      }
      if (!attrNames.hasOwnProperty(attrName)) {
        attrNames[attrName] = 1;
      } else {
        return getErrorObject("InvalidAttr", "Attribute '" + attrName + "' is repeated.", getPositionFromMatch(matches[i]));
      }
    }
    return true;
  }
  function validateNumberAmpersand(xmlData, i) {
    let re = /\d/;
    if (xmlData[i] === "x") {
      i++;
      re = /[\da-fA-F]/;
    }
    for (;i < xmlData.length; i++) {
      if (xmlData[i] === ";")
        return i;
      if (!xmlData[i].match(re))
        break;
    }
    return -1;
  }
  function validateAmpersand(xmlData, i) {
    i++;
    if (xmlData[i] === ";")
      return -1;
    if (xmlData[i] === "#") {
      i++;
      return validateNumberAmpersand(xmlData, i);
    }
    let count = 0;
    for (;i < xmlData.length; i++, count++) {
      if (xmlData[i].match(/\w/) && count < 20)
        continue;
      if (xmlData[i] === ";")
        break;
      return -1;
    }
    return i;
  }
  function getErrorObject(code, message, lineNumber) {
    return {
      err: {
        code,
        msg: message,
        line: lineNumber.line || lineNumber,
        col: lineNumber.col
      }
    };
  }
  function validateAttrName(attrName) {
    return util.isName(attrName);
  }
  function validateTagName(tagname) {
    return util.isName(tagname);
  }
  function getLineNumberForPosition(xmlData, index) {
    const lines = xmlData.substring(0, index).split(/\r?\n/);
    return {
      line: lines.length,
      col: lines[lines.length - 1].length + 1
    };
  }
  function getPositionFromMatch(match) {
    return match.startIndex + match[1].length;
  }
});

// node_modules/fast-xml-parser/src/xmlparser/OptionsBuilder.js
var require_OptionsBuilder = __commonJS((exports) => {
  var { DANGEROUS_PROPERTY_NAMES, criticalProperties } = require_util();
  var defaultOnDangerousProperty = (name) => {
    if (DANGEROUS_PROPERTY_NAMES.includes(name)) {
      return "__" + name;
    }
    return name;
  };
  var defaultOptions = {
    preserveOrder: false,
    attributeNamePrefix: "@_",
    attributesGroupName: false,
    textNodeName: "#text",
    ignoreAttributes: true,
    removeNSPrefix: false,
    allowBooleanAttributes: false,
    parseTagValue: true,
    parseAttributeValue: false,
    trimValues: true,
    cdataPropName: false,
    numberParseOptions: {
      hex: true,
      leadingZeros: true,
      eNotation: true
    },
    tagValueProcessor: function(tagName, val) {
      return val;
    },
    attributeValueProcessor: function(attrName, val) {
      return val;
    },
    stopNodes: [],
    alwaysCreateTextNode: false,
    isArray: () => false,
    commentPropName: false,
    unpairedTags: [],
    processEntities: true,
    htmlEntities: false,
    ignoreDeclaration: false,
    ignorePiTags: false,
    transformTagName: false,
    transformAttributeName: false,
    updateTag: function(tagName, jPath, attrs) {
      return tagName;
    },
    captureMetaData: false,
    maxNestedTags: 100,
    strictReservedNames: true,
    onDangerousProperty: defaultOnDangerousProperty
  };
  function validatePropertyName(propertyName, optionName) {
    if (typeof propertyName !== "string") {
      return;
    }
    const normalized = propertyName.toLowerCase();
    if (DANGEROUS_PROPERTY_NAMES.some((dangerous) => normalized === dangerous.toLowerCase())) {
      throw new Error(`[SECURITY] Invalid ${optionName}: "${propertyName}" is a reserved JavaScript keyword that could cause prototype pollution`);
    }
    if (criticalProperties.some((dangerous) => normalized === dangerous.toLowerCase())) {
      throw new Error(`[SECURITY] Invalid ${optionName}: "${propertyName}" is a reserved JavaScript keyword that could cause prototype pollution`);
    }
  }
  function normalizeProcessEntities(value) {
    if (typeof value === "boolean") {
      return {
        enabled: value,
        maxEntitySize: 1e4,
        maxExpansionDepth: 10,
        maxTotalExpansions: 1000,
        maxExpandedLength: 1e5,
        allowedTags: null,
        tagFilter: null
      };
    }
    if (typeof value === "object" && value !== null) {
      return {
        enabled: value.enabled !== false,
        maxEntitySize: Math.max(1, value.maxEntitySize ?? 1e4),
        maxExpansionDepth: Math.max(1, value.maxExpansionDepth ?? 10),
        maxTotalExpansions: Math.max(1, value.maxTotalExpansions ?? 1000),
        maxExpandedLength: Math.max(1, value.maxExpandedLength ?? 1e5),
        maxEntityCount: Math.max(1, value.maxEntityCount ?? 100),
        allowedTags: value.allowedTags ?? null,
        tagFilter: value.tagFilter ?? null
      };
    }
    return normalizeProcessEntities(true);
  }
  var buildOptions = function(options) {
    const built = Object.assign({}, defaultOptions, options);
    const propertyNameOptions = [
      { value: built.attributeNamePrefix, name: "attributeNamePrefix" },
      { value: built.attributesGroupName, name: "attributesGroupName" },
      { value: built.textNodeName, name: "textNodeName" },
      { value: built.cdataPropName, name: "cdataPropName" },
      { value: built.commentPropName, name: "commentPropName" }
    ];
    for (const { value, name } of propertyNameOptions) {
      if (value) {
        validatePropertyName(value, name);
      }
    }
    if (built.onDangerousProperty === null) {
      built.onDangerousProperty = defaultOnDangerousProperty;
    }
    built.processEntities = normalizeProcessEntities(built.processEntities);
    return built;
  };
  exports.buildOptions = buildOptions;
  exports.defaultOptions = defaultOptions;
});

// node_modules/fast-xml-parser/src/xmlparser/xmlNode.js
var require_xmlNode = __commonJS((exports, module) => {
  class XmlNode {
    constructor(tagname) {
      this.tagname = tagname;
      this.child = [];
      this[":@"] = {};
    }
    add(key, val) {
      if (key === "__proto__")
        key = "#__proto__";
      this.child.push({ [key]: val });
    }
    addChild(node) {
      if (node.tagname === "__proto__")
        node.tagname = "#__proto__";
      if (node[":@"] && Object.keys(node[":@"]).length > 0) {
        this.child.push({ [node.tagname]: node.child, [":@"]: node[":@"] });
      } else {
        this.child.push({ [node.tagname]: node.child });
      }
    }
  }
  module.exports = XmlNode;
});

// node_modules/fast-xml-parser/src/xmlparser/DocTypeReader.js
var require_DocTypeReader = __commonJS((exports, module) => {
  var util = require_util();

  class DocTypeReader {
    constructor(options) {
      this.suppressValidationErr = !options;
      this.options = options || {};
    }
    readDocType(xmlData, i) {
      const entities = Object.create(null);
      let entityCount = 0;
      if (xmlData[i + 3] === "O" && xmlData[i + 4] === "C" && xmlData[i + 5] === "T" && xmlData[i + 6] === "Y" && xmlData[i + 7] === "P" && xmlData[i + 8] === "E") {
        i = i + 9;
        let angleBracketsCount = 1;
        let hasBody = false, comment = false;
        let exp = "";
        for (;i < xmlData.length; i++) {
          if (xmlData[i] === "<" && !comment) {
            if (hasBody && hasSeq(xmlData, "!ENTITY", i)) {
              i += 7;
              let entityName, val;
              [entityName, val, i] = this.readEntityExp(xmlData, i + 1, this.suppressValidationErr);
              if (val.indexOf("&") === -1) {
                if (this.options.enabled !== false && this.options.maxEntityCount != null && entityCount >= this.options.maxEntityCount) {
                  throw new Error(`Entity count (${entityCount + 1}) exceeds maximum allowed (${this.options.maxEntityCount})`);
                }
                const escaped = entityName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                entities[entityName] = {
                  regx: RegExp(`&${escaped};`, "g"),
                  val
                };
                entityCount++;
              }
            } else if (hasBody && hasSeq(xmlData, "!ELEMENT", i)) {
              i += 8;
              const { index } = this.readElementExp(xmlData, i + 1);
              i = index;
            } else if (hasBody && hasSeq(xmlData, "!ATTLIST", i)) {
              i += 8;
            } else if (hasBody && hasSeq(xmlData, "!NOTATION", i)) {
              i += 9;
              const { index } = this.readNotationExp(xmlData, i + 1, this.suppressValidationErr);
              i = index;
            } else if (hasSeq(xmlData, "!--", i)) {
              comment = true;
            } else {
              throw new Error(`Invalid DOCTYPE`);
            }
            angleBracketsCount++;
            exp = "";
          } else if (xmlData[i] === ">") {
            if (comment) {
              if (xmlData[i - 1] === "-" && xmlData[i - 2] === "-") {
                comment = false;
                angleBracketsCount--;
              }
            } else {
              angleBracketsCount--;
            }
            if (angleBracketsCount === 0) {
              break;
            }
          } else if (xmlData[i] === "[") {
            hasBody = true;
          } else {
            exp += xmlData[i];
          }
        }
        if (angleBracketsCount !== 0) {
          throw new Error(`Unclosed DOCTYPE`);
        }
      } else {
        throw new Error(`Invalid Tag instead of DOCTYPE`);
      }
      return { entities, i };
    }
    readEntityExp(xmlData, i) {
      i = skipWhitespace(xmlData, i);
      let entityName = "";
      while (i < xmlData.length && !/\s/.test(xmlData[i]) && xmlData[i] !== '"' && xmlData[i] !== "'") {
        entityName += xmlData[i];
        i++;
      }
      validateEntityName(entityName);
      i = skipWhitespace(xmlData, i);
      if (!this.suppressValidationErr) {
        if (xmlData.substring(i, i + 6).toUpperCase() === "SYSTEM") {
          throw new Error("External entities are not supported");
        } else if (xmlData[i] === "%") {
          throw new Error("Parameter entities are not supported");
        }
      }
      let entityValue = "";
      [i, entityValue] = this.readIdentifierVal(xmlData, i, "entity");
      if (this.options.enabled !== false && this.options.maxEntitySize != null && entityValue.length > this.options.maxEntitySize) {
        throw new Error(`Entity "${entityName}" size (${entityValue.length}) exceeds maximum allowed size (${this.options.maxEntitySize})`);
      }
      i--;
      return [entityName, entityValue, i];
    }
    readNotationExp(xmlData, i) {
      i = skipWhitespace(xmlData, i);
      let notationName = "";
      while (i < xmlData.length && !/\s/.test(xmlData[i])) {
        notationName += xmlData[i];
        i++;
      }
      !this.suppressValidationErr && validateEntityName(notationName);
      i = skipWhitespace(xmlData, i);
      const identifierType = xmlData.substring(i, i + 6).toUpperCase();
      if (!this.suppressValidationErr && identifierType !== "SYSTEM" && identifierType !== "PUBLIC") {
        throw new Error(`Expected SYSTEM or PUBLIC, found "${identifierType}"`);
      }
      i += identifierType.length;
      i = skipWhitespace(xmlData, i);
      let publicIdentifier = null;
      let systemIdentifier = null;
      if (identifierType === "PUBLIC") {
        [i, publicIdentifier] = this.readIdentifierVal(xmlData, i, "publicIdentifier");
        i = skipWhitespace(xmlData, i);
        if (xmlData[i] === '"' || xmlData[i] === "'") {
          [i, systemIdentifier] = this.readIdentifierVal(xmlData, i, "systemIdentifier");
        }
      } else if (identifierType === "SYSTEM") {
        [i, systemIdentifier] = this.readIdentifierVal(xmlData, i, "systemIdentifier");
        if (!this.suppressValidationErr && !systemIdentifier) {
          throw new Error("Missing mandatory system identifier for SYSTEM notation");
        }
      }
      return { notationName, publicIdentifier, systemIdentifier, index: --i };
    }
    readIdentifierVal(xmlData, i, type) {
      let identifierVal = "";
      const startChar = xmlData[i];
      if (startChar !== '"' && startChar !== "'") {
        throw new Error(`Expected quoted string, found "${startChar}"`);
      }
      i++;
      while (i < xmlData.length && xmlData[i] !== startChar) {
        identifierVal += xmlData[i];
        i++;
      }
      if (xmlData[i] !== startChar) {
        throw new Error(`Unterminated ${type} value`);
      }
      i++;
      return [i, identifierVal];
    }
    readElementExp(xmlData, i) {
      i = skipWhitespace(xmlData, i);
      let elementName = "";
      while (i < xmlData.length && !/\s/.test(xmlData[i])) {
        elementName += xmlData[i];
        i++;
      }
      if (!this.suppressValidationErr && !util.isName(elementName)) {
        throw new Error(`Invalid element name: "${elementName}"`);
      }
      i = skipWhitespace(xmlData, i);
      let contentModel = "";
      if (xmlData[i] === "E" && hasSeq(xmlData, "MPTY", i)) {
        i += 4;
      } else if (xmlData[i] === "A" && hasSeq(xmlData, "NY", i)) {
        i += 2;
      } else if (xmlData[i] === "(") {
        i++;
        while (i < xmlData.length && xmlData[i] !== ")") {
          contentModel += xmlData[i];
          i++;
        }
        if (xmlData[i] !== ")") {
          throw new Error("Unterminated content model");
        }
      } else if (!this.suppressValidationErr) {
        throw new Error(`Invalid Element Expression, found "${xmlData[i]}"`);
      }
      return {
        elementName,
        contentModel: contentModel.trim(),
        index: i
      };
    }
    readAttlistExp(xmlData, i) {
      i = skipWhitespace(xmlData, i);
      let elementName = "";
      while (i < xmlData.length && !/\s/.test(xmlData[i])) {
        elementName += xmlData[i];
        i++;
      }
      validateEntityName(elementName);
      i = skipWhitespace(xmlData, i);
      let attributeName = "";
      while (i < xmlData.length && !/\s/.test(xmlData[i])) {
        attributeName += xmlData[i];
        i++;
      }
      if (!validateEntityName(attributeName)) {
        throw new Error(`Invalid attribute name: "${attributeName}"`);
      }
      i = skipWhitespace(xmlData, i);
      let attributeType = "";
      if (xmlData.substring(i, i + 8).toUpperCase() === "NOTATION") {
        attributeType = "NOTATION";
        i += 8;
        i = skipWhitespace(xmlData, i);
        if (xmlData[i] !== "(") {
          throw new Error(`Expected '(', found "${xmlData[i]}"`);
        }
        i++;
        let allowedNotations = [];
        while (i < xmlData.length && xmlData[i] !== ")") {
          let notation = "";
          while (i < xmlData.length && xmlData[i] !== "|" && xmlData[i] !== ")") {
            notation += xmlData[i];
            i++;
          }
          notation = notation.trim();
          if (!validateEntityName(notation)) {
            throw new Error(`Invalid notation name: "${notation}"`);
          }
          allowedNotations.push(notation);
          if (xmlData[i] === "|") {
            i++;
            i = skipWhitespace(xmlData, i);
          }
        }
        if (xmlData[i] !== ")") {
          throw new Error("Unterminated list of notations");
        }
        i++;
        attributeType += " (" + allowedNotations.join("|") + ")";
      } else {
        while (i < xmlData.length && !/\s/.test(xmlData[i])) {
          attributeType += xmlData[i];
          i++;
        }
        const validTypes = ["CDATA", "ID", "IDREF", "IDREFS", "ENTITY", "ENTITIES", "NMTOKEN", "NMTOKENS"];
        if (!this.suppressValidationErr && !validTypes.includes(attributeType.toUpperCase())) {
          throw new Error(`Invalid attribute type: "${attributeType}"`);
        }
      }
      i = skipWhitespace(xmlData, i);
      let defaultValue = "";
      if (xmlData.substring(i, i + 8).toUpperCase() === "#REQUIRED") {
        defaultValue = "#REQUIRED";
        i += 8;
      } else if (xmlData.substring(i, i + 7).toUpperCase() === "#IMPLIED") {
        defaultValue = "#IMPLIED";
        i += 7;
      } else {
        [i, defaultValue] = this.readIdentifierVal(xmlData, i, "ATTLIST");
      }
      return {
        elementName,
        attributeName,
        attributeType,
        defaultValue,
        index: i
      };
    }
  }
  var skipWhitespace = (data, index) => {
    while (index < data.length && /\s/.test(data[index])) {
      index++;
    }
    return index;
  };
  function hasSeq(data, seq, i) {
    for (let j = 0;j < seq.length; j++) {
      if (seq[j] !== data[i + j + 1])
        return false;
    }
    return true;
  }
  function validateEntityName(name) {
    if (util.isName(name))
      return name;
    else
      throw new Error(`Invalid entity name ${name}`);
  }
  module.exports = DocTypeReader;
});

// node_modules/strnum/strnum.js
var require_strnum = __commonJS((exports, module) => {
  var hexRegex = /^[-+]?0x[a-fA-F0-9]+$/;
  var numRegex = /^([\-\+])?(0*)([0-9]*(\.[0-9]*)?)$/;
  var consider = {
    hex: true,
    leadingZeros: true,
    decimalPoint: ".",
    eNotation: true
  };
  function toNumber(str, options = {}) {
    options = Object.assign({}, consider, options);
    if (!str || typeof str !== "string")
      return str;
    let trimmedStr = str.trim();
    if (options.skipLike !== undefined && options.skipLike.test(trimmedStr))
      return str;
    else if (str === "0")
      return 0;
    else if (options.hex && hexRegex.test(trimmedStr)) {
      return parse_int(trimmedStr, 16);
    } else if (trimmedStr.search(/[eE]/) !== -1) {
      const notation = trimmedStr.match(/^([-\+])?(0*)([0-9]*(\.[0-9]*)?[eE][-\+]?[0-9]+)$/);
      if (notation) {
        if (options.leadingZeros) {
          trimmedStr = (notation[1] || "") + notation[3];
        } else {
          if (notation[2] === "0" && notation[3][0] === ".") {} else {
            return str;
          }
        }
        return options.eNotation ? Number(trimmedStr) : str;
      } else {
        return str;
      }
    } else {
      const match = numRegex.exec(trimmedStr);
      if (match) {
        const sign = match[1];
        const leadingZeros = match[2];
        let numTrimmedByZeros = trimZeros(match[3]);
        if (!options.leadingZeros && leadingZeros.length > 0 && sign && trimmedStr[2] !== ".")
          return str;
        else if (!options.leadingZeros && leadingZeros.length > 0 && !sign && trimmedStr[1] !== ".")
          return str;
        else if (options.leadingZeros && leadingZeros === str)
          return 0;
        else {
          const num = Number(trimmedStr);
          const numStr = "" + num;
          if (numStr.search(/[eE]/) !== -1) {
            if (options.eNotation)
              return num;
            else
              return str;
          } else if (trimmedStr.indexOf(".") !== -1) {
            if (numStr === "0" && numTrimmedByZeros === "")
              return num;
            else if (numStr === numTrimmedByZeros)
              return num;
            else if (sign && numStr === "-" + numTrimmedByZeros)
              return num;
            else
              return str;
          }
          if (leadingZeros) {
            return numTrimmedByZeros === numStr || sign + numTrimmedByZeros === numStr ? num : str;
          } else {
            return trimmedStr === numStr || trimmedStr === sign + numStr ? num : str;
          }
        }
      } else {
        return str;
      }
    }
  }
  function trimZeros(numStr) {
    if (numStr && numStr.indexOf(".") !== -1) {
      numStr = numStr.replace(/0+$/, "");
      if (numStr === ".")
        numStr = "0";
      else if (numStr[0] === ".")
        numStr = "0" + numStr;
      else if (numStr[numStr.length - 1] === ".")
        numStr = numStr.substr(0, numStr.length - 1);
      return numStr;
    }
    return numStr;
  }
  function parse_int(numStr, base) {
    if (parseInt)
      return parseInt(numStr, base);
    else if (Number.parseInt)
      return Number.parseInt(numStr, base);
    else if (window && window.parseInt)
      return window.parseInt(numStr, base);
    else
      throw new Error("parseInt, Number.parseInt, window.parseInt are not supported");
  }
  module.exports = toNumber;
});

// node_modules/fast-xml-parser/src/ignoreAttributes.js
var require_ignoreAttributes = __commonJS((exports, module) => {
  function getIgnoreAttributesFn(ignoreAttributes) {
    if (typeof ignoreAttributes === "function") {
      return ignoreAttributes;
    }
    if (Array.isArray(ignoreAttributes)) {
      return (attrName) => {
        for (const pattern of ignoreAttributes) {
          if (typeof pattern === "string" && attrName === pattern) {
            return true;
          }
          if (pattern instanceof RegExp && pattern.test(attrName)) {
            return true;
          }
        }
      };
    }
    return () => false;
  }
  module.exports = getIgnoreAttributesFn;
});

// node_modules/fast-xml-parser/src/xmlparser/OrderedObjParser.js
var require_OrderedObjParser = __commonJS((exports, module) => {
  var util = require_util();
  var xmlNode = require_xmlNode();
  var DocTypeReader = require_DocTypeReader();
  var toNumber = require_strnum();
  var getIgnoreAttributesFn = require_ignoreAttributes();

  class OrderedObjParser {
    constructor(options) {
      this.options = options;
      this.currentNode = null;
      this.tagsNodeStack = [];
      this.docTypeEntities = {};
      this.lastEntities = {
        apos: { regex: /&(apos|#39|#x27);/g, val: "'" },
        gt: { regex: /&(gt|#62|#x3E);/g, val: ">" },
        lt: { regex: /&(lt|#60|#x3C);/g, val: "<" },
        quot: { regex: /&(quot|#34|#x22);/g, val: '"' }
      };
      this.ampEntity = { regex: /&(amp|#38|#x26);/g, val: "&" };
      this.htmlEntities = {
        space: { regex: /&(nbsp|#160);/g, val: " " },
        cent: { regex: /&(cent|#162);/g, val: "\xA2" },
        pound: { regex: /&(pound|#163);/g, val: "\xA3" },
        yen: { regex: /&(yen|#165);/g, val: "\xA5" },
        euro: { regex: /&(euro|#8364);/g, val: "\u20AC" },
        copyright: { regex: /&(copy|#169);/g, val: "\xA9" },
        reg: { regex: /&(reg|#174);/g, val: "\xAE" },
        inr: { regex: /&(inr|#8377);/g, val: "\u20B9" },
        num_dec: { regex: /&#([0-9]{1,7});/g, val: (_, str) => fromCodePoint(str, 10, "&#") },
        num_hex: { regex: /&#x([0-9a-fA-F]{1,6});/g, val: (_, str) => fromCodePoint(str, 16, "&#x") }
      };
      this.addExternalEntities = addExternalEntities;
      this.parseXml = parseXml;
      this.parseTextData = parseTextData;
      this.resolveNameSpace = resolveNameSpace;
      this.buildAttributesMap = buildAttributesMap;
      this.isItStopNode = isItStopNode;
      this.replaceEntitiesValue = replaceEntitiesValue;
      this.readStopNodeData = readStopNodeData;
      this.saveTextToParentTag = saveTextToParentTag;
      this.addChild = addChild;
      this.ignoreAttributesFn = getIgnoreAttributesFn(this.options.ignoreAttributes);
      this.entityExpansionCount = 0;
      this.currentExpandedLength = 0;
      if (this.options.stopNodes && this.options.stopNodes.length > 0) {
        this.stopNodesExact = new Set;
        this.stopNodesWildcard = new Set;
        for (let i = 0;i < this.options.stopNodes.length; i++) {
          const stopNodeExp = this.options.stopNodes[i];
          if (typeof stopNodeExp !== "string")
            continue;
          if (stopNodeExp.startsWith("*.")) {
            this.stopNodesWildcard.add(stopNodeExp.substring(2));
          } else {
            this.stopNodesExact.add(stopNodeExp);
          }
        }
      }
    }
  }
  function addExternalEntities(externalEntities) {
    const entKeys = Object.keys(externalEntities);
    for (let i = 0;i < entKeys.length; i++) {
      const ent = entKeys[i];
      const escaped = ent.replace(/[.\-+*:]/g, "\\.");
      this.lastEntities[ent] = {
        regex: new RegExp("&" + escaped + ";", "g"),
        val: externalEntities[ent]
      };
    }
  }
  function parseTextData(val, tagName, jPath, dontTrim, hasAttributes, isLeafNode, escapeEntities) {
    if (val !== undefined) {
      if (this.options.trimValues && !dontTrim) {
        val = val.trim();
      }
      if (val.length > 0) {
        if (!escapeEntities)
          val = this.replaceEntitiesValue(val, tagName, jPath);
        const newval = this.options.tagValueProcessor(tagName, val, jPath, hasAttributes, isLeafNode);
        if (newval === null || newval === undefined) {
          return val;
        } else if (typeof newval !== typeof val || newval !== val) {
          return newval;
        } else if (this.options.trimValues) {
          return parseValue(val, this.options.parseTagValue, this.options.numberParseOptions);
        } else {
          const trimmedVal = val.trim();
          if (trimmedVal === val) {
            return parseValue(val, this.options.parseTagValue, this.options.numberParseOptions);
          } else {
            return val;
          }
        }
      }
    }
  }
  function resolveNameSpace(tagname) {
    if (this.options.removeNSPrefix) {
      const tags = tagname.split(":");
      const prefix = tagname.charAt(0) === "/" ? "/" : "";
      if (tags[0] === "xmlns") {
        return "";
      }
      if (tags.length === 2) {
        tagname = prefix + tags[1];
      }
    }
    return tagname;
  }
  var attrsRegx = new RegExp(`([^\\s=]+)\\s*(=\\s*(['"])([\\s\\S]*?)\\3)?`, "gm");
  function buildAttributesMap(attrStr, jPath, tagName) {
    if (this.options.ignoreAttributes !== true && typeof attrStr === "string") {
      const matches = util.getAllMatches(attrStr, attrsRegx);
      const len = matches.length;
      const attrs = {};
      for (let i = 0;i < len; i++) {
        const attrName = this.resolveNameSpace(matches[i][1]);
        if (this.ignoreAttributesFn(attrName, jPath)) {
          continue;
        }
        let oldVal = matches[i][4];
        let aName = this.options.attributeNamePrefix + attrName;
        if (attrName.length) {
          if (this.options.transformAttributeName) {
            aName = this.options.transformAttributeName(aName);
          }
          aName = sanitizeName(aName, this.options);
          if (oldVal !== undefined) {
            if (this.options.trimValues) {
              oldVal = oldVal.trim();
            }
            oldVal = this.replaceEntitiesValue(oldVal, tagName, jPath);
            const newVal = this.options.attributeValueProcessor(attrName, oldVal, jPath);
            if (newVal === null || newVal === undefined) {
              attrs[aName] = oldVal;
            } else if (typeof newVal !== typeof oldVal || newVal !== oldVal) {
              attrs[aName] = newVal;
            } else {
              attrs[aName] = parseValue(oldVal, this.options.parseAttributeValue, this.options.numberParseOptions);
            }
          } else if (this.options.allowBooleanAttributes) {
            attrs[aName] = true;
          }
        }
      }
      if (!Object.keys(attrs).length) {
        return;
      }
      if (this.options.attributesGroupName) {
        const attrCollection = {};
        attrCollection[this.options.attributesGroupName] = attrs;
        return attrCollection;
      }
      return attrs;
    }
  }
  var parseXml = function(xmlData) {
    xmlData = xmlData.replace(/\r\n?/g, `
`);
    const xmlObj = new xmlNode("!xml");
    let currentNode = xmlObj;
    let textData = "";
    let jPath = "";
    this.entityExpansionCount = 0;
    this.currentExpandedLength = 0;
    const docTypeReader = new DocTypeReader(this.options.processEntities);
    for (let i = 0;i < xmlData.length; i++) {
      const ch = xmlData[i];
      if (ch === "<") {
        if (xmlData[i + 1] === "/") {
          const closeIndex = findClosingIndex(xmlData, ">", i, "Closing Tag is not closed.");
          let tagName = xmlData.substring(i + 2, closeIndex).trim();
          if (this.options.removeNSPrefix) {
            const colonIndex = tagName.indexOf(":");
            if (colonIndex !== -1) {
              tagName = tagName.substr(colonIndex + 1);
            }
          }
          if (this.options.transformTagName) {
            tagName = this.options.transformTagName(tagName);
          }
          if (currentNode) {
            textData = this.saveTextToParentTag(textData, currentNode, jPath);
          }
          const lastTagName = jPath.substring(jPath.lastIndexOf(".") + 1);
          if (tagName && this.options.unpairedTags.indexOf(tagName) !== -1) {
            throw new Error(`Unpaired tag can not be used as closing tag: </${tagName}>`);
          }
          let propIndex = 0;
          if (lastTagName && this.options.unpairedTags.indexOf(lastTagName) !== -1) {
            propIndex = jPath.lastIndexOf(".", jPath.lastIndexOf(".") - 1);
            this.tagsNodeStack.pop();
          } else {
            propIndex = jPath.lastIndexOf(".");
          }
          jPath = jPath.substring(0, propIndex);
          currentNode = this.tagsNodeStack.pop();
          textData = "";
          i = closeIndex;
        } else if (xmlData[i + 1] === "?") {
          let tagData = readTagExp(xmlData, i, false, "?>");
          if (!tagData)
            throw new Error("Pi Tag is not closed.");
          textData = this.saveTextToParentTag(textData, currentNode, jPath);
          if (this.options.ignoreDeclaration && tagData.tagName === "?xml" || this.options.ignorePiTags) {} else {
            const childNode = new xmlNode(tagData.tagName);
            childNode.add(this.options.textNodeName, "");
            if (tagData.tagName !== tagData.tagExp && tagData.attrExpPresent) {
              childNode[":@"] = this.buildAttributesMap(tagData.tagExp, jPath, tagData.tagName);
            }
            this.addChild(currentNode, childNode, jPath, i);
          }
          i = tagData.closeIndex + 1;
        } else if (xmlData.substr(i + 1, 3) === "!--") {
          const endIndex = findClosingIndex(xmlData, "-->", i + 4, "Comment is not closed.");
          if (this.options.commentPropName) {
            const comment = xmlData.substring(i + 4, endIndex - 2);
            textData = this.saveTextToParentTag(textData, currentNode, jPath);
            currentNode.add(this.options.commentPropName, [{ [this.options.textNodeName]: comment }]);
          }
          i = endIndex;
        } else if (xmlData.substr(i + 1, 2) === "!D") {
          const result = docTypeReader.readDocType(xmlData, i);
          this.docTypeEntities = result.entities;
          i = result.i;
        } else if (xmlData.substr(i + 1, 2) === "![") {
          const closeIndex = findClosingIndex(xmlData, "]]>", i, "CDATA is not closed.") - 2;
          const tagExp = xmlData.substring(i + 9, closeIndex);
          textData = this.saveTextToParentTag(textData, currentNode, jPath);
          let val = this.parseTextData(tagExp, currentNode.tagname, jPath, true, false, true, true);
          if (val == undefined)
            val = "";
          if (this.options.cdataPropName) {
            currentNode.add(this.options.cdataPropName, [{ [this.options.textNodeName]: tagExp }]);
          } else {
            currentNode.add(this.options.textNodeName, val);
          }
          i = closeIndex + 2;
        } else {
          let result = readTagExp(xmlData, i, this.options.removeNSPrefix);
          let tagName = result.tagName;
          const rawTagName = result.rawTagName;
          let tagExp = result.tagExp;
          let attrExpPresent = result.attrExpPresent;
          let closeIndex = result.closeIndex;
          if (this.options.transformTagName) {
            const newTagName = this.options.transformTagName(tagName);
            if (tagExp === tagName) {
              tagExp = newTagName;
            }
            tagName = newTagName;
          }
          if (this.options.strictReservedNames && (tagName === this.options.commentPropName || tagName === this.options.cdataPropName || tagName === this.options.textNodeName || tagName === this.options.attributesGroupName)) {
            throw new Error(`Invalid tag name: ${tagName}`);
          }
          if (currentNode && textData) {
            if (currentNode.tagname !== "!xml") {
              textData = this.saveTextToParentTag(textData, currentNode, jPath, false);
            }
          }
          const lastTag = currentNode;
          if (lastTag && this.options.unpairedTags.indexOf(lastTag.tagname) !== -1) {
            currentNode = this.tagsNodeStack.pop();
            jPath = jPath.substring(0, jPath.lastIndexOf("."));
          }
          if (tagName !== xmlObj.tagname) {
            jPath += jPath ? "." + tagName : tagName;
          }
          const startIndex = i;
          if (this.isItStopNode(this.stopNodesExact, this.stopNodesWildcard, jPath, tagName)) {
            let tagContent = "";
            if (tagExp.length > 0 && tagExp.lastIndexOf("/") === tagExp.length - 1) {
              if (tagName[tagName.length - 1] === "/") {
                tagName = tagName.substr(0, tagName.length - 1);
                jPath = jPath.substr(0, jPath.length - 1);
                tagExp = tagName;
              } else {
                tagExp = tagExp.substr(0, tagExp.length - 1);
              }
              i = result.closeIndex;
            } else if (this.options.unpairedTags.indexOf(tagName) !== -1) {
              i = result.closeIndex;
            } else {
              const result2 = this.readStopNodeData(xmlData, rawTagName, closeIndex + 1);
              if (!result2)
                throw new Error(`Unexpected end of ${rawTagName}`);
              i = result2.i;
              tagContent = result2.tagContent;
            }
            const childNode = new xmlNode(tagName);
            if (tagName !== tagExp && attrExpPresent) {
              childNode[":@"] = this.buildAttributesMap(tagExp, jPath, tagName);
            }
            if (tagContent) {
              tagContent = this.parseTextData(tagContent, tagName, jPath, true, attrExpPresent, true, true);
            }
            jPath = jPath.substr(0, jPath.lastIndexOf("."));
            childNode.add(this.options.textNodeName, tagContent);
            this.addChild(currentNode, childNode, jPath, startIndex);
          } else {
            if (tagExp.length > 0 && tagExp.lastIndexOf("/") === tagExp.length - 1) {
              if (tagName[tagName.length - 1] === "/") {
                tagName = tagName.substr(0, tagName.length - 1);
                jPath = jPath.substr(0, jPath.length - 1);
                tagExp = tagName;
              } else {
                tagExp = tagExp.substr(0, tagExp.length - 1);
              }
              if (this.options.transformTagName) {
                const newTagName = this.options.transformTagName(tagName);
                if (tagExp === tagName) {
                  tagExp = newTagName;
                }
                tagName = newTagName;
              }
              const childNode = new xmlNode(tagName);
              if (tagName !== tagExp && attrExpPresent) {
                childNode[":@"] = this.buildAttributesMap(tagExp, jPath, tagName);
              }
              this.addChild(currentNode, childNode, jPath, startIndex);
              jPath = jPath.substr(0, jPath.lastIndexOf("."));
            } else if (this.options.unpairedTags.indexOf(tagName) !== -1) {
              const childNode = new xmlNode(tagName);
              if (tagName !== tagExp && attrExpPresent) {
                childNode[":@"] = this.buildAttributesMap(tagExp, jPath);
              }
              this.addChild(currentNode, childNode, jPath, startIndex);
              jPath = jPath.substr(0, jPath.lastIndexOf("."));
              i = result.closeIndex;
              continue;
            } else {
              const childNode = new xmlNode(tagName);
              if (this.tagsNodeStack.length > this.options.maxNestedTags) {
                throw new Error("Maximum nested tags exceeded");
              }
              this.tagsNodeStack.push(currentNode);
              if (tagName !== tagExp && attrExpPresent) {
                childNode[":@"] = this.buildAttributesMap(tagExp, jPath, tagName);
              }
              this.addChild(currentNode, childNode, jPath);
              currentNode = childNode;
            }
            textData = "";
            i = closeIndex;
          }
        }
      } else {
        textData += xmlData[i];
      }
    }
    return xmlObj.child;
  };
  function addChild(currentNode, childNode, jPath, startIndex) {
    if (!this.options.captureMetaData)
      startIndex = undefined;
    const result = this.options.updateTag(childNode.tagname, jPath, childNode[":@"]);
    if (result === false) {} else if (typeof result === "string") {
      childNode.tagname = result;
      currentNode.addChild(childNode, startIndex);
    } else {
      currentNode.addChild(childNode, startIndex);
    }
  }
  var replaceEntitiesValue = function(val, tagName, jPath) {
    if (val.indexOf("&") === -1) {
      return val;
    }
    const entityConfig = this.options.processEntities;
    if (!entityConfig.enabled) {
      return val;
    }
    if (entityConfig.allowedTags) {
      if (!entityConfig.allowedTags.includes(tagName)) {
        return val;
      }
    }
    if (entityConfig.tagFilter) {
      if (!entityConfig.tagFilter(tagName, jPath)) {
        return val;
      }
    }
    for (let entityName in this.docTypeEntities) {
      const entity = this.docTypeEntities[entityName];
      const matches = val.match(entity.regx);
      if (matches) {
        this.entityExpansionCount += matches.length;
        if (entityConfig.maxTotalExpansions && this.entityExpansionCount > entityConfig.maxTotalExpansions) {
          throw new Error(`Entity expansion limit exceeded: ${this.entityExpansionCount} > ${entityConfig.maxTotalExpansions}`);
        }
        const lengthBefore = val.length;
        val = val.replace(entity.regx, entity.val);
        if (entityConfig.maxExpandedLength) {
          this.currentExpandedLength += val.length - lengthBefore;
          if (this.currentExpandedLength > entityConfig.maxExpandedLength) {
            throw new Error(`Total expanded content size exceeded: ${this.currentExpandedLength} > ${entityConfig.maxExpandedLength}`);
          }
        }
      }
    }
    if (val.indexOf("&") === -1)
      return val;
    for (const entityName of Object.keys(this.lastEntities)) {
      const entity = this.lastEntities[entityName];
      const matches = val.match(entity.regex);
      if (matches) {
        this.entityExpansionCount += matches.length;
        if (entityConfig.maxTotalExpansions && this.entityExpansionCount > entityConfig.maxTotalExpansions) {
          throw new Error(`Entity expansion limit exceeded: ${this.entityExpansionCount} > ${entityConfig.maxTotalExpansions}`);
        }
      }
      val = val.replace(entity.regex, entity.val);
    }
    if (val.indexOf("&") === -1)
      return val;
    if (this.options.htmlEntities) {
      for (const entityName of Object.keys(this.htmlEntities)) {
        const entity = this.htmlEntities[entityName];
        const matches = val.match(entity.regex);
        if (matches) {
          this.entityExpansionCount += matches.length;
          if (entityConfig.maxTotalExpansions && this.entityExpansionCount > entityConfig.maxTotalExpansions) {
            throw new Error(`Entity expansion limit exceeded: ${this.entityExpansionCount} > ${entityConfig.maxTotalExpansions}`);
          }
        }
        val = val.replace(entity.regex, entity.val);
      }
    }
    val = val.replace(this.ampEntity.regex, this.ampEntity.val);
    return val;
  };
  function saveTextToParentTag(textData, parentNode, jPath, isLeafNode) {
    if (textData) {
      if (isLeafNode === undefined)
        isLeafNode = parentNode.child.length === 0;
      textData = this.parseTextData(textData, parentNode.tagname, jPath, false, parentNode[":@"] ? Object.keys(parentNode[":@"]).length !== 0 : false, isLeafNode);
      if (textData !== undefined && textData !== "")
        parentNode.add(this.options.textNodeName, textData);
      textData = "";
    }
    return textData;
  }
  function isItStopNode(stopNodesExact, stopNodesWildcard, jPath, currentTagName) {
    if (stopNodesWildcard && stopNodesWildcard.has(currentTagName))
      return true;
    if (stopNodesExact && stopNodesExact.has(jPath))
      return true;
    return false;
  }
  function tagExpWithClosingIndex(xmlData, i, closingChar = ">") {
    let attrBoundary;
    let tagExp = "";
    for (let index = i;index < xmlData.length; index++) {
      let ch = xmlData[index];
      if (attrBoundary) {
        if (ch === attrBoundary)
          attrBoundary = "";
      } else if (ch === '"' || ch === "'") {
        attrBoundary = ch;
      } else if (ch === closingChar[0]) {
        if (closingChar[1]) {
          if (xmlData[index + 1] === closingChar[1]) {
            return {
              data: tagExp,
              index
            };
          }
        } else {
          return {
            data: tagExp,
            index
          };
        }
      } else if (ch === "\t") {
        ch = " ";
      }
      tagExp += ch;
    }
  }
  function findClosingIndex(xmlData, str, i, errMsg) {
    const closingIndex = xmlData.indexOf(str, i);
    if (closingIndex === -1) {
      throw new Error(errMsg);
    } else {
      return closingIndex + str.length - 1;
    }
  }
  function readTagExp(xmlData, i, removeNSPrefix, closingChar = ">") {
    const result = tagExpWithClosingIndex(xmlData, i + 1, closingChar);
    if (!result)
      return;
    let tagExp = result.data;
    const closeIndex = result.index;
    const separatorIndex = tagExp.search(/\s/);
    let tagName = tagExp;
    let attrExpPresent = true;
    if (separatorIndex !== -1) {
      tagName = tagExp.substring(0, separatorIndex);
      tagExp = tagExp.substring(separatorIndex + 1).trimStart();
    }
    const rawTagName = tagName;
    if (removeNSPrefix) {
      const colonIndex = tagName.indexOf(":");
      if (colonIndex !== -1) {
        tagName = tagName.substr(colonIndex + 1);
        attrExpPresent = tagName !== result.data.substr(colonIndex + 1);
      }
    }
    return {
      tagName,
      tagExp,
      closeIndex,
      attrExpPresent,
      rawTagName
    };
  }
  function readStopNodeData(xmlData, tagName, i) {
    const startIndex = i;
    let openTagCount = 1;
    for (;i < xmlData.length; i++) {
      if (xmlData[i] === "<") {
        if (xmlData[i + 1] === "/") {
          const closeIndex = findClosingIndex(xmlData, ">", i, `${tagName} is not closed`);
          let closeTagName = xmlData.substring(i + 2, closeIndex).trim();
          if (closeTagName === tagName) {
            openTagCount--;
            if (openTagCount === 0) {
              return {
                tagContent: xmlData.substring(startIndex, i),
                i: closeIndex
              };
            }
          }
          i = closeIndex;
        } else if (xmlData[i + 1] === "?") {
          const closeIndex = findClosingIndex(xmlData, "?>", i + 1, "StopNode is not closed.");
          i = closeIndex;
        } else if (xmlData.substr(i + 1, 3) === "!--") {
          const closeIndex = findClosingIndex(xmlData, "-->", i + 3, "StopNode is not closed.");
          i = closeIndex;
        } else if (xmlData.substr(i + 1, 2) === "![") {
          const closeIndex = findClosingIndex(xmlData, "]]>", i, "StopNode is not closed.") - 2;
          i = closeIndex;
        } else {
          const tagData = readTagExp(xmlData, i, ">");
          if (tagData) {
            const openTagName = tagData && tagData.tagName;
            if (openTagName === tagName && tagData.tagExp[tagData.tagExp.length - 1] !== "/") {
              openTagCount++;
            }
            i = tagData.closeIndex;
          }
        }
      }
    }
  }
  function parseValue(val, shouldParse, options) {
    if (shouldParse && typeof val === "string") {
      const newval = val.trim();
      if (newval === "true")
        return true;
      else if (newval === "false")
        return false;
      else
        return toNumber(val, options);
    } else {
      if (util.isExist(val)) {
        return val;
      } else {
        return "";
      }
    }
  }
  function fromCodePoint(str, base, prefix) {
    const codePoint = Number.parseInt(str, base);
    if (codePoint >= 0 && codePoint <= 1114111) {
      return String.fromCodePoint(codePoint);
    } else {
      return prefix + str + ";";
    }
  }
  function sanitizeName(name, options) {
    if (util.criticalProperties.includes(name)) {
      throw new Error(`[SECURITY] Invalid name: "${name}" is a reserved JavaScript keyword that could cause prototype pollution`);
    } else if (util.DANGEROUS_PROPERTY_NAMES.includes(name)) {
      return options.onDangerousProperty(name);
    }
    return name;
  }
  module.exports = OrderedObjParser;
});

// node_modules/fast-xml-parser/src/xmlparser/node2json.js
var require_node2json = __commonJS((exports) => {
  function prettify(node, options) {
    return compress(node, options);
  }
  function compress(arr, options, jPath) {
    let text;
    const compressedObj = {};
    for (let i = 0;i < arr.length; i++) {
      const tagObj = arr[i];
      const property = propName(tagObj);
      let newJpath = "";
      if (jPath === undefined)
        newJpath = property;
      else
        newJpath = jPath + "." + property;
      if (property === options.textNodeName) {
        if (text === undefined)
          text = tagObj[property];
        else
          text += "" + tagObj[property];
      } else if (property === undefined) {
        continue;
      } else if (tagObj[property]) {
        let val = compress(tagObj[property], options, newJpath);
        const isLeaf = isLeafTag(val, options);
        if (tagObj[":@"]) {
          assignAttributes(val, tagObj[":@"], newJpath, options);
        } else if (Object.keys(val).length === 1 && val[options.textNodeName] !== undefined && !options.alwaysCreateTextNode) {
          val = val[options.textNodeName];
        } else if (Object.keys(val).length === 0) {
          if (options.alwaysCreateTextNode)
            val[options.textNodeName] = "";
          else
            val = "";
        }
        if (compressedObj[property] !== undefined && compressedObj.hasOwnProperty(property)) {
          if (!Array.isArray(compressedObj[property])) {
            compressedObj[property] = [compressedObj[property]];
          }
          compressedObj[property].push(val);
        } else {
          if (options.isArray(property, newJpath, isLeaf)) {
            compressedObj[property] = [val];
          } else {
            compressedObj[property] = val;
          }
        }
      }
    }
    if (typeof text === "string") {
      if (text.length > 0)
        compressedObj[options.textNodeName] = text;
    } else if (text !== undefined)
      compressedObj[options.textNodeName] = text;
    return compressedObj;
  }
  function propName(obj) {
    const keys = Object.keys(obj);
    for (let i = 0;i < keys.length; i++) {
      const key = keys[i];
      if (key !== ":@")
        return key;
    }
  }
  function assignAttributes(obj, attrMap, jpath, options) {
    if (attrMap) {
      const keys = Object.keys(attrMap);
      const len = keys.length;
      for (let i = 0;i < len; i++) {
        const atrrName = keys[i];
        if (options.isArray(atrrName, jpath + "." + atrrName, true, true)) {
          obj[atrrName] = [attrMap[atrrName]];
        } else {
          obj[atrrName] = attrMap[atrrName];
        }
      }
    }
  }
  function isLeafTag(obj, options) {
    const { textNodeName } = options;
    const propCount = Object.keys(obj).length;
    if (propCount === 0) {
      return true;
    }
    if (propCount === 1 && (obj[textNodeName] || typeof obj[textNodeName] === "boolean" || obj[textNodeName] === 0)) {
      return true;
    }
    return false;
  }
  exports.prettify = prettify;
});

// node_modules/fast-xml-parser/src/xmlparser/XMLParser.js
var require_XMLParser = __commonJS((exports, module) => {
  var { buildOptions } = require_OptionsBuilder();
  var OrderedObjParser = require_OrderedObjParser();
  var { prettify } = require_node2json();
  var validator = require_validator();

  class XMLParser {
    constructor(options) {
      this.externalEntities = {};
      this.options = buildOptions(options);
    }
    parse(xmlData, validationOption) {
      if (typeof xmlData === "string") {} else if (xmlData.toString) {
        xmlData = xmlData.toString();
      } else {
        throw new Error("XML data is accepted in String or Bytes[] form.");
      }
      if (validationOption) {
        if (validationOption === true)
          validationOption = {};
        const result = validator.validate(xmlData, validationOption);
        if (result !== true) {
          throw Error(`${result.err.msg}:${result.err.line}:${result.err.col}`);
        }
      }
      const orderedObjParser = new OrderedObjParser(this.options);
      orderedObjParser.addExternalEntities(this.externalEntities);
      const orderedResult = orderedObjParser.parseXml(xmlData);
      if (this.options.preserveOrder || orderedResult === undefined)
        return orderedResult;
      else
        return prettify(orderedResult, this.options);
    }
    addEntity(key, value) {
      if (value.indexOf("&") !== -1) {
        throw new Error("Entity value can't have '&'");
      } else if (key.indexOf("&") !== -1 || key.indexOf(";") !== -1) {
        throw new Error("An entity must be set without '&' and ';'. Eg. use '#xD' for '&#xD;'");
      } else if (value === "&") {
        throw new Error("An entity with value '&' is not permitted");
      } else {
        this.externalEntities[key] = value;
      }
    }
  }
  module.exports = XMLParser;
});

// node_modules/fast-xml-parser/src/xmlbuilder/orderedJs2Xml.js
var require_orderedJs2Xml = __commonJS((exports, module) => {
  var EOL = `
`;
  function toXml(jArray, options) {
    let indentation = "";
    if (options.format && options.indentBy.length > 0) {
      indentation = EOL;
    }
    return arrToStr(jArray, options, "", indentation);
  }
  function arrToStr(arr, options, jPath, indentation) {
    let xmlStr = "";
    let isPreviousElementTag = false;
    if (!Array.isArray(arr)) {
      if (arr !== undefined && arr !== null) {
        let text = arr.toString();
        text = replaceEntitiesValue(text, options);
        return text;
      }
      return "";
    }
    for (let i = 0;i < arr.length; i++) {
      const tagObj = arr[i];
      const tagName = propName(tagObj);
      if (tagName === undefined)
        continue;
      let newJPath = "";
      if (jPath.length === 0)
        newJPath = tagName;
      else
        newJPath = `${jPath}.${tagName}`;
      if (tagName === options.textNodeName) {
        let tagText = tagObj[tagName];
        if (!isStopNode(newJPath, options)) {
          tagText = options.tagValueProcessor(tagName, tagText);
          tagText = replaceEntitiesValue(tagText, options);
        }
        if (isPreviousElementTag) {
          xmlStr += indentation;
        }
        xmlStr += tagText;
        isPreviousElementTag = false;
        continue;
      } else if (tagName === options.cdataPropName) {
        if (isPreviousElementTag) {
          xmlStr += indentation;
        }
        xmlStr += `<![CDATA[${tagObj[tagName][0][options.textNodeName]}]]>`;
        isPreviousElementTag = false;
        continue;
      } else if (tagName === options.commentPropName) {
        xmlStr += indentation + `<!--${tagObj[tagName][0][options.textNodeName]}-->`;
        isPreviousElementTag = true;
        continue;
      } else if (tagName[0] === "?") {
        const attStr2 = attr_to_str(tagObj[":@"], options);
        const tempInd = tagName === "?xml" ? "" : indentation;
        let piTextNodeName = tagObj[tagName][0][options.textNodeName];
        piTextNodeName = piTextNodeName.length !== 0 ? " " + piTextNodeName : "";
        xmlStr += tempInd + `<${tagName}${piTextNodeName}${attStr2}?>`;
        isPreviousElementTag = true;
        continue;
      }
      let newIdentation = indentation;
      if (newIdentation !== "") {
        newIdentation += options.indentBy;
      }
      const attStr = attr_to_str(tagObj[":@"], options);
      const tagStart = indentation + `<${tagName}${attStr}`;
      const tagValue = arrToStr(tagObj[tagName], options, newJPath, newIdentation);
      if (options.unpairedTags.indexOf(tagName) !== -1) {
        if (options.suppressUnpairedNode)
          xmlStr += tagStart + ">";
        else
          xmlStr += tagStart + "/>";
      } else if ((!tagValue || tagValue.length === 0) && options.suppressEmptyNode) {
        xmlStr += tagStart + "/>";
      } else if (tagValue && tagValue.endsWith(">")) {
        xmlStr += tagStart + `>${tagValue}${indentation}</${tagName}>`;
      } else {
        xmlStr += tagStart + ">";
        if (tagValue && indentation !== "" && (tagValue.includes("/>") || tagValue.includes("</"))) {
          xmlStr += indentation + options.indentBy + tagValue + indentation;
        } else {
          xmlStr += tagValue;
        }
        xmlStr += `</${tagName}>`;
      }
      isPreviousElementTag = true;
    }
    return xmlStr;
  }
  function propName(obj) {
    const keys = Object.keys(obj);
    for (let i = 0;i < keys.length; i++) {
      const key = keys[i];
      if (!Object.prototype.hasOwnProperty.call(obj, key))
        continue;
      if (key !== ":@")
        return key;
    }
  }
  function attr_to_str(attrMap, options) {
    let attrStr = "";
    if (attrMap && !options.ignoreAttributes) {
      for (let attr in attrMap) {
        if (!Object.prototype.hasOwnProperty.call(attrMap, attr))
          continue;
        let attrVal = options.attributeValueProcessor(attr, attrMap[attr]);
        attrVal = replaceEntitiesValue(attrVal, options);
        if (attrVal === true && options.suppressBooleanAttributes) {
          attrStr += ` ${attr.substr(options.attributeNamePrefix.length)}`;
        } else {
          attrStr += ` ${attr.substr(options.attributeNamePrefix.length)}="${attrVal}"`;
        }
      }
    }
    return attrStr;
  }
  function isStopNode(jPath, options) {
    jPath = jPath.substr(0, jPath.length - options.textNodeName.length - 1);
    let tagName = jPath.substr(jPath.lastIndexOf(".") + 1);
    for (let index in options.stopNodes) {
      if (options.stopNodes[index] === jPath || options.stopNodes[index] === "*." + tagName)
        return true;
    }
    return false;
  }
  function replaceEntitiesValue(textValue, options) {
    if (textValue && textValue.length > 0 && options.processEntities) {
      for (let i = 0;i < options.entities.length; i++) {
        const entity = options.entities[i];
        textValue = textValue.replace(entity.regex, entity.val);
      }
    }
    return textValue;
  }
  module.exports = toXml;
});

// node_modules/fast-xml-parser/src/xmlbuilder/json2xml.js
var require_json2xml = __commonJS((exports, module) => {
  var buildFromOrderedJs = require_orderedJs2Xml();
  var getIgnoreAttributesFn = require_ignoreAttributes();
  var defaultOptions = {
    attributeNamePrefix: "@_",
    attributesGroupName: false,
    textNodeName: "#text",
    ignoreAttributes: true,
    cdataPropName: false,
    format: false,
    indentBy: "  ",
    suppressEmptyNode: false,
    suppressUnpairedNode: true,
    suppressBooleanAttributes: true,
    tagValueProcessor: function(key, a) {
      return a;
    },
    attributeValueProcessor: function(attrName, a) {
      return a;
    },
    preserveOrder: false,
    commentPropName: false,
    unpairedTags: [],
    entities: [
      { regex: new RegExp("&", "g"), val: "&amp;" },
      { regex: new RegExp(">", "g"), val: "&gt;" },
      { regex: new RegExp("<", "g"), val: "&lt;" },
      { regex: new RegExp("'", "g"), val: "&apos;" },
      { regex: new RegExp('"', "g"), val: "&quot;" }
    ],
    processEntities: true,
    stopNodes: [],
    oneListGroup: false
  };
  function Builder(options) {
    this.options = Object.assign({}, defaultOptions, options);
    if (this.options.ignoreAttributes === true || this.options.attributesGroupName) {
      this.isAttribute = function() {
        return false;
      };
    } else {
      this.ignoreAttributesFn = getIgnoreAttributesFn(this.options.ignoreAttributes);
      this.attrPrefixLen = this.options.attributeNamePrefix.length;
      this.isAttribute = isAttribute;
    }
    this.processTextOrObjNode = processTextOrObjNode;
    if (this.options.format) {
      this.indentate = indentate;
      this.tagEndChar = `>
`;
      this.newLine = `
`;
    } else {
      this.indentate = function() {
        return "";
      };
      this.tagEndChar = ">";
      this.newLine = "";
    }
  }
  Builder.prototype.build = function(jObj) {
    if (this.options.preserveOrder) {
      return buildFromOrderedJs(jObj, this.options);
    } else {
      if (Array.isArray(jObj) && this.options.arrayNodeName && this.options.arrayNodeName.length > 1) {
        jObj = {
          [this.options.arrayNodeName]: jObj
        };
      }
      return this.j2x(jObj, 0, []).val;
    }
  };
  Builder.prototype.j2x = function(jObj, level, ajPath) {
    let attrStr = "";
    let val = "";
    const jPath = ajPath.join(".");
    for (let key in jObj) {
      if (!Object.prototype.hasOwnProperty.call(jObj, key))
        continue;
      if (typeof jObj[key] === "undefined") {
        if (this.isAttribute(key)) {
          val += "";
        }
      } else if (jObj[key] === null) {
        if (this.isAttribute(key)) {
          val += "";
        } else if (key === this.options.cdataPropName) {
          val += "";
        } else if (key[0] === "?") {
          val += this.indentate(level) + "<" + key + "?" + this.tagEndChar;
        } else {
          val += this.indentate(level) + "<" + key + "/" + this.tagEndChar;
        }
      } else if (jObj[key] instanceof Date) {
        val += this.buildTextValNode(jObj[key], key, "", level);
      } else if (typeof jObj[key] !== "object") {
        const attr = this.isAttribute(key);
        if (attr && !this.ignoreAttributesFn(attr, jPath)) {
          attrStr += this.buildAttrPairStr(attr, "" + jObj[key]);
        } else if (!attr) {
          if (key === this.options.textNodeName) {
            let newval = this.options.tagValueProcessor(key, "" + jObj[key]);
            val += this.replaceEntitiesValue(newval);
          } else {
            val += this.buildTextValNode(jObj[key], key, "", level);
          }
        }
      } else if (Array.isArray(jObj[key])) {
        const arrLen = jObj[key].length;
        let listTagVal = "";
        let listTagAttr = "";
        for (let j = 0;j < arrLen; j++) {
          const item = jObj[key][j];
          if (typeof item === "undefined") {} else if (item === null) {
            if (key[0] === "?")
              val += this.indentate(level) + "<" + key + "?" + this.tagEndChar;
            else
              val += this.indentate(level) + "<" + key + "/" + this.tagEndChar;
          } else if (typeof item === "object") {
            if (this.options.oneListGroup) {
              const result = this.j2x(item, level + 1, ajPath.concat(key));
              listTagVal += result.val;
              if (this.options.attributesGroupName && item.hasOwnProperty(this.options.attributesGroupName)) {
                listTagAttr += result.attrStr;
              }
            } else {
              listTagVal += this.processTextOrObjNode(item, key, level, ajPath);
            }
          } else {
            if (this.options.oneListGroup) {
              let textValue = this.options.tagValueProcessor(key, item);
              textValue = this.replaceEntitiesValue(textValue);
              listTagVal += textValue;
            } else {
              listTagVal += this.buildTextValNode(item, key, "", level);
            }
          }
        }
        if (this.options.oneListGroup) {
          listTagVal = this.buildObjectNode(listTagVal, key, listTagAttr, level);
        }
        val += listTagVal;
      } else {
        if (this.options.attributesGroupName && key === this.options.attributesGroupName) {
          const Ks = Object.keys(jObj[key]);
          const L = Ks.length;
          for (let j = 0;j < L; j++) {
            attrStr += this.buildAttrPairStr(Ks[j], "" + jObj[key][Ks[j]]);
          }
        } else {
          val += this.processTextOrObjNode(jObj[key], key, level, ajPath);
        }
      }
    }
    return { attrStr, val };
  };
  Builder.prototype.buildAttrPairStr = function(attrName, val) {
    val = this.options.attributeValueProcessor(attrName, "" + val);
    val = this.replaceEntitiesValue(val);
    if (this.options.suppressBooleanAttributes && val === "true") {
      return " " + attrName;
    } else
      return " " + attrName + '="' + val + '"';
  };
  function processTextOrObjNode(object, key, level, ajPath) {
    const result = this.j2x(object, level + 1, ajPath.concat(key));
    if (object[this.options.textNodeName] !== undefined && Object.keys(object).length === 1) {
      return this.buildTextValNode(object[this.options.textNodeName], key, result.attrStr, level);
    } else {
      return this.buildObjectNode(result.val, key, result.attrStr, level);
    }
  }
  Builder.prototype.buildObjectNode = function(val, key, attrStr, level) {
    if (val === "") {
      if (key[0] === "?")
        return this.indentate(level) + "<" + key + attrStr + "?" + this.tagEndChar;
      else {
        return this.indentate(level) + "<" + key + attrStr + this.closeTag(key) + this.tagEndChar;
      }
    } else {
      let tagEndExp = "</" + key + this.tagEndChar;
      let piClosingChar = "";
      if (key[0] === "?") {
        piClosingChar = "?";
        tagEndExp = "";
      }
      if ((attrStr || attrStr === "") && val.indexOf("<") === -1) {
        return this.indentate(level) + "<" + key + attrStr + piClosingChar + ">" + val + tagEndExp;
      } else if (this.options.commentPropName !== false && key === this.options.commentPropName && piClosingChar.length === 0) {
        return this.indentate(level) + `<!--${val}-->` + this.newLine;
      } else {
        return this.indentate(level) + "<" + key + attrStr + piClosingChar + this.tagEndChar + val + this.indentate(level) + tagEndExp;
      }
    }
  };
  Builder.prototype.closeTag = function(key) {
    let closeTag = "";
    if (this.options.unpairedTags.indexOf(key) !== -1) {
      if (!this.options.suppressUnpairedNode)
        closeTag = "/";
    } else if (this.options.suppressEmptyNode) {
      closeTag = "/";
    } else {
      closeTag = `></${key}`;
    }
    return closeTag;
  };
  Builder.prototype.buildTextValNode = function(val, key, attrStr, level) {
    if (this.options.cdataPropName !== false && key === this.options.cdataPropName) {
      return this.indentate(level) + `<![CDATA[${val}]]>` + this.newLine;
    } else if (this.options.commentPropName !== false && key === this.options.commentPropName) {
      return this.indentate(level) + `<!--${val}-->` + this.newLine;
    } else if (key[0] === "?") {
      return this.indentate(level) + "<" + key + attrStr + "?" + this.tagEndChar;
    } else {
      let textValue = this.options.tagValueProcessor(key, val);
      textValue = this.replaceEntitiesValue(textValue);
      if (textValue === "") {
        return this.indentate(level) + "<" + key + attrStr + this.closeTag(key) + this.tagEndChar;
      } else {
        return this.indentate(level) + "<" + key + attrStr + ">" + textValue + "</" + key + this.tagEndChar;
      }
    }
  };
  Builder.prototype.replaceEntitiesValue = function(textValue) {
    if (textValue && textValue.length > 0 && this.options.processEntities) {
      for (let i = 0;i < this.options.entities.length; i++) {
        const entity = this.options.entities[i];
        textValue = textValue.replace(entity.regex, entity.val);
      }
    }
    return textValue;
  };
  function indentate(level) {
    return this.options.indentBy.repeat(level);
  }
  function isAttribute(name) {
    if (name.startsWith(this.options.attributeNamePrefix) && name !== this.options.textNodeName) {
      return name.substr(this.attrPrefixLen);
    } else {
      return false;
    }
  }
  module.exports = Builder;
});

// node_modules/fast-xml-parser/src/fxp.js
var require_fxp = __commonJS((exports, module) => {
  var validator = require_validator();
  var XMLParser = require_XMLParser();
  var XMLBuilder = require_json2xml();
  module.exports = {
    XMLParser,
    XMLValidator: validator,
    XMLBuilder
  };
});

// browse-mobile/src/ref-system.ts
var import_fast_xml_parser = __toESM(require_fxp(), 1);
var IOS_INTERACTIVE_TYPES = new Set([
  "XCUIElementTypeButton",
  "XCUIElementTypeTextField",
  "XCUIElementTypeSecureTextField",
  "XCUIElementTypeSwitch",
  "XCUIElementTypeSlider",
  "XCUIElementTypeLink",
  "XCUIElementTypeSearchField",
  "XCUIElementTypeTextView",
  "XCUIElementTypeCell",
  "XCUIElementTypeImage",
  "XCUIElementTypeSegmentedControl",
  "XCUIElementTypePicker",
  "XCUIElementTypePickerWheel",
  "XCUIElementTypeStepper",
  "XCUIElementTypePageIndicator",
  "XCUIElementTypeTab",
  "XCUIElementTypeTabBar"
]);
var IOS_WRAPPER_TYPES = new Set([
  "XCUIElementTypeApplication",
  "XCUIElementTypeWindow",
  "XCUIElementTypeOther",
  "XCUIElementTypeGroup",
  "XCUIElementTypeScrollView",
  "XCUIElementTypeTable",
  "XCUIElementTypeCollectionView",
  "XCUIElementTypeNavigationBar",
  "XCUIElementTypeToolbar",
  "XCUIElementTypeStatusBar",
  "XCUIElementTypeKeyboard"
]);
function parseBounds(attrs) {
  const x = parseInt(attrs.x, 10);
  const y = parseInt(attrs.y, 10);
  const width = parseInt(attrs.width, 10);
  const height = parseInt(attrs.height, 10);
  if ([x, y, width, height].some((v) => isNaN(v)))
    return null;
  return { x, y, width, height };
}
function isInteractive(type, attrs) {
  if (IOS_INTERACTIVE_TYPES.has(type))
    return true;
  if (type === "XCUIElementTypeStaticText") {
    const accessible = attrs.accessible;
    if (accessible === "true" && attrs.label)
      return true;
  }
  return false;
}
function getTagAndChildren(node) {
  const attrs = node[":@"] || {};
  for (const key of Object.keys(node)) {
    if (key === ":@" || key === "#text" || key === "?xml")
      continue;
    const children = node[key];
    return {
      tag: key,
      children: Array.isArray(children) ? children : [],
      attrs
    };
  }
  return null;
}
function walkNode(node, ctx) {
  if (ctx.depth > ctx.maxDepth)
    return;
  const parsed = getTagAndChildren(node);
  if (!parsed)
    return;
  const { tag: type, children, attrs } = parsed;
  if (type === "AppiumAUT") {
    for (const child of children) {
      if (typeof child === "object" && child !== null) {
        walkNode(child, ctx);
      }
    }
    return;
  }
  if (!type.startsWith("XCUIElementType"))
    return;
  const label = attrs.label || null;
  const visible = attrs.visible !== "false";
  if (!visible)
    return;
  ctx.xpathParts.push(`${type}[${attrs.index || "0"}]`);
  const xpath = "//" + ctx.xpathParts.join("/");
  const indent = "  ".repeat(ctx.depth);
  if (isInteractive(type, attrs)) {
    ctx.counter++;
    const refKey = `e${ctx.counter}`;
    const friendlyType = type.replace("XCUIElementType", "");
    let resolveStrategy = "xpath";
    if (attrs.testID) {
      resolveStrategy = "testID";
    } else if (label) {
      resolveStrategy = "accessibilityLabel";
    }
    ctx.refs.set(refKey, {
      xpath,
      bounds: parseBounds(attrs),
      label,
      testID: attrs.testID || null,
      elementType: type,
      resolveStrategy
    });
    const displayLabel = label ? ` "${label}"` : "";
    ctx.lines.push(`${indent}@${refKey} ${friendlyType}${displayLabel}`);
  } else if (!IOS_WRAPPER_TYPES.has(type)) {
    if (label) {
      const friendlyType = type.replace("XCUIElementType", "");
      ctx.lines.push(`${indent}${friendlyType}: "${label}"`);
    }
  }
  ctx.depth++;
  for (const child of children) {
    if (typeof child === "object" && child !== null) {
      walkNode(child, ctx);
    }
  }
  ctx.depth--;
  ctx.xpathParts.pop();
}
function parseXmlToRefs(xml) {
  if (!xml || xml.trim().length === 0) {
    return { refs: new Map, text: "(empty screen)" };
  }
  const parser = new import_fast_xml_parser.XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    preserveOrder: true,
    allowBooleanAttributes: true
  });
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    return {
      refs: new Map,
      text: `(error parsing accessibility tree: ${err instanceof Error ? err.message : String(err)})`
    };
  }
  const ctx = {
    refs: new Map,
    lines: [],
    counter: 0,
    xpathParts: [],
    depth: 0,
    maxDepth: 150
  };
  if (Array.isArray(parsed)) {
    for (const node of parsed) {
      if (typeof node === "object" && node !== null) {
        walkNode(node, ctx);
      }
    }
  }
  const summary = `${ctx.refs.size} interactive element${ctx.refs.size !== 1 ? "s" : ""} found`;
  const text = ctx.lines.length > 0 ? `${summary}

${ctx.lines.join(`
`)}` : `${summary}

(no interactive elements on this screen)`;
  return { refs: ctx.refs, text };
}
async function resolveRef(ref, refs, findElement) {
  const key = ref.startsWith("@") ? ref.slice(1) : ref;
  const entry = refs.get(key);
  if (!entry) {
    return null;
  }
  let element = null;
  if (entry.resolveStrategy === "testID" && entry.testID) {
    element = await findElement("accessibility id", entry.testID);
  } else if (entry.resolveStrategy === "accessibilityLabel" && entry.label) {
    element = await findElement("accessibility id", entry.label);
  }
  if (!element) {
    element = await findElement("xpath", entry.xpath);
  }
  if (element) {
    return { element, usedCoordinates: false };
  }
  if (entry.label && entry.resolveStrategy !== "accessibilityLabel") {
    element = await findElement("accessibility id", entry.label);
    if (element) {
      return { element, usedCoordinates: false };
    }
  }
  if (entry.bounds) {
    return {
      element: {
        _coordinateTap: true,
        x: entry.bounds.x + entry.bounds.width / 2,
        y: entry.bounds.y + entry.bounds.height / 2
      },
      usedCoordinates: true
    };
  }
  return null;
}
function snapshotDiff(previous, current) {
  if (!previous) {
    return current + `

(no previous snapshot to diff against)`;
  }
  const prevLines = previous.split(`
`);
  const currLines = current.split(`
`);
  const result = [];
  const maxLen = Math.max(prevLines.length, currLines.length);
  let hasChanges = false;
  for (let i = 0;i < maxLen; i++) {
    const prev = prevLines[i] || "";
    const curr = currLines[i] || "";
    if (prev === curr) {
      result.push(`  ${curr}`);
    } else {
      hasChanges = true;
      if (prev)
        result.push(`- ${prev}`);
      if (curr)
        result.push(`+ ${curr}`);
    }
  }
  if (!hasChanges) {
    return "(no changes since last snapshot)";
  }
  return result.join(`
`);
}

// browse-mobile/src/platform/ios.ts
import { execSync } from "child_process";
function assertSafeShellArg(value, name) {
  if (/[;&|`$"'\\<>(){}\n\r]/.test(value)) {
    throw new Error(`Unsafe ${name}: contains shell metacharacters`);
  }
}
function listDevices() {
  try {
    const output = execSync("xcrun simctl list devices available -j", {
      encoding: "utf-8",
      timeout: 1e4
    });
    const data = JSON.parse(output);
    const devices = [];
    for (const [runtime, devs] of Object.entries(data.devices || {})) {
      if (!Array.isArray(devs))
        continue;
      for (const dev of devs) {
        devices.push({
          udid: dev.udid,
          name: dev.name,
          state: dev.state,
          runtime: runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "")
        });
      }
    }
    return devices;
  } catch {
    return [];
  }
}
function ensureBootedSimulator() {
  const devices = listDevices();
  const booted = devices.find((d) => d.state === "Booted");
  if (booted)
    return booted;
  const iphones = devices.filter((d) => d.name.includes("iPhone") && d.state === "Shutdown").sort((a, b) => {
    return b.name.localeCompare(a.name);
  });
  const target = iphones[0] || devices[0];
  if (!target)
    return null;
  try {
    assertSafeShellArg(target.udid, "simulator UDID");
    execSync(`xcrun simctl boot "${target.udid}"`, {
      timeout: 30000,
      stdio: "pipe"
    });
    return { ...target, state: "Booted" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("current state: Booted")) {
      return { ...target, state: "Booted" };
    }
    return null;
  }
}

// browse-mobile/src/mobile-driver.ts
import * as fs from "fs";
import * as path from "path";
var APPIUM_BASE = "http://127.0.0.1:4723";
var REQUEST_TIMEOUT = 30000;
var SESSION_TIMEOUT = 180000;
async function appiumPost(sessionId, endpoint, body, timeout = REQUEST_TIMEOUT) {
  const url = `${APPIUM_BASE}/session/${sessionId}${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
    signal: AbortSignal.timeout(timeout)
  });
  const data = await res.json();
  if (!res.ok) {
    const err = data.value;
    const msg = typeof err === "string" ? err : err?.message || JSON.stringify(err);
    throw new Error(`Appium error: ${msg}`);
  }
  return data.value;
}
async function appiumGet(sessionId, endpoint, timeout = REQUEST_TIMEOUT) {
  const url = `${APPIUM_BASE}/session/${sessionId}${endpoint}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout)
  });
  const data = await res.json();
  if (!res.ok) {
    const err = data.value;
    const msg = typeof err === "string" ? err : err?.message || JSON.stringify(err);
    throw new Error(`Appium error: ${msg}`);
  }
  return data.value;
}
async function appiumDelete(sessionId, timeout = REQUEST_TIMEOUT) {
  const url = `${APPIUM_BASE}/session/${sessionId}`;
  await fetch(url, {
    method: "DELETE",
    signal: AbortSignal.timeout(timeout)
  });
}
async function findElement(sessionId, using, value) {
  try {
    const result = await appiumPost(sessionId, "/element", { using, value });
    return result["element-6066-11e4-a52e-4f735466cecf"] || result["ELEMENT"] || Object.values(result)[0] || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such element") || msg.includes("NoSuchElement") || msg.includes("unable to find")) {
      return null;
    }
    throw err;
  }
}
function tapAction(x, y) {
  return {
    actions: [{
      type: "pointer",
      id: "finger1",
      parameters: { pointerType: "touch" },
      actions: [
        { type: "pointerMove", duration: 0, x: Math.round(x), y: Math.round(y) },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 }
      ]
    }]
  };
}
function swipeAction(startX, startY, endX, endY, durationMs = 300) {
  return {
    actions: [{
      type: "pointer",
      id: "finger1",
      parameters: { pointerType: "touch" },
      actions: [
        { type: "pointerMove", duration: 0, x: startX, y: startY },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: durationMs, x: endX, y: endY },
        { type: "pointerUp", button: 0 }
      ]
    }]
  };
}

class MobileDriver {
  sessionId = null;
  refs = new Map;
  lastSnapshot = null;
  options;
  _isConnected = false;
  constructor(options) {
    this.options = options;
  }
  async connect() {
    const sim = ensureBootedSimulator();
    if (!sim) {
      throw new Error("No iOS Simulator available. Run: xcrun simctl list devices available");
    }
    const capabilities = {
      platformName: "iOS",
      "appium:automationName": this.options.automationName || "XCUITest",
      "appium:deviceName": this.options.deviceName || sim.name,
      "appium:udid": sim.udid,
      "appium:bundleId": this.options.bundleId,
      "appium:autoAcceptAlerts": true,
      "appium:noReset": true,
      "appium:newCommandTimeout": 1800,
      "appium:wdaLaunchTimeout": 120000,
      "appium:wdaConnectionTimeout": 120000
    };
    if (this.options.appPath) {
      capabilities["appium:app"] = this.options.appPath;
    }
    if (this.options.platformVersion) {
      capabilities["appium:platformVersion"] = this.options.platformVersion;
    }
    const res = await fetch(`${APPIUM_BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capabilities: { alwaysMatch: capabilities, firstMatch: [{}] }
      }),
      signal: AbortSignal.timeout(SESSION_TIMEOUT)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Appium session creation failed (${res.status}): ${errText}`);
    }
    const data = await res.json();
    this.sessionId = data.value.sessionId;
    this._isConnected = true;
  }
  async disconnect() {
    if (this.sessionId) {
      try {
        await appiumDelete(this.sessionId);
      } catch {}
      this.sessionId = null;
    }
    this._isConnected = false;
    this.refs.clear();
    this.lastSnapshot = null;
  }
  get isConnected() {
    return this._isConnected && this.sessionId !== null;
  }
  async isHealthy() {
    if (!this.sessionId)
      return false;
    try {
      await appiumGet(this.sessionId, "/source", 5000);
      return true;
    } catch {
      return false;
    }
  }
  ensureSession() {
    if (!this.sessionId) {
      throw new Error("Not connected to Appium. Call connect() first.");
    }
    return this.sessionId;
  }
  setRefMap(refs) {
    this.refs = refs;
  }
  getRefCount() {
    return this.refs.size;
  }
  clearRefs() {
    this.refs.clear();
  }
  setLastSnapshot(text) {
    this.lastSnapshot = text;
  }
  getLastSnapshot() {
    return this.lastSnapshot;
  }
  async goto(target) {
    const sid = this.ensureSession();
    if (target.startsWith("app://")) {
      const bundleId = target.replace("app://", "");
      try {
        await appiumPost(sid, "/execute/sync", {
          script: "mobile: terminateApp",
          args: [{ bundleId }]
        });
      } catch {}
      await appiumPost(sid, "/execute/sync", {
        script: "mobile: launchApp",
        args: [{ bundleId }]
      });
      return `Launched ${bundleId}`;
    }
    try {
      await appiumPost(sid, "/url", { url: target });
      return `Navigated to ${target}`;
    } catch (err) {
      return `Deep link failed: ${err instanceof Error ? err.message : String(err)}. Navigate manually via click commands.`;
    }
  }
  async click(refOrSelector) {
    const sid = this.ensureSession();
    if (refOrSelector.startsWith("@")) {
      const finder = async (strategy, selector) => {
        const using = strategy === "accessibility id" ? "accessibility id" : "xpath";
        return findElement(sid, using, selector);
      };
      let result = await resolveRef(refOrSelector, this.refs, finder);
      if (!result) {
        await this.snapshot([]);
        result = await resolveRef(refOrSelector, this.refs, finder);
        if (!result) {
          throw new Error(`Element ${refOrSelector} no longer exists \u2014 screen may have navigated`);
        }
      }
      return this.performClick(sid, result);
    }
    const labelMatch = refOrSelector.match(/^(?:~|label:)(.+)$/);
    if (labelMatch) {
      const label = labelMatch[1].replace(/^["']|["']$/g, "");
      const elementId2 = await findElement(sid, "accessibility id", label);
      if (elementId2) {
        await appiumPost(sid, `/element/${elementId2}/click`);
        return `Clicked label:${label}`;
      }
      throw new Error(`Element with accessibility label "${label}" not found`);
    }
    const elementId = await findElement(sid, "xpath", refOrSelector);
    if (elementId) {
      await appiumPost(sid, `/element/${elementId}/click`);
      return `Clicked ${refOrSelector}`;
    }
    throw new Error(`Element not found: ${refOrSelector}`);
  }
  async performClick(sid, result) {
    if (result.usedCoordinates) {
      const coords = result.element;
      await appiumPost(sid, "/actions", tapAction(coords.x, coords.y));
      return `Tapped at (${Math.round(coords.x)}, ${Math.round(coords.y)}) \u2014 coordinate fallback. Consider adding accessibilityLabel.`;
    }
    const elementId = result.element;
    await appiumPost(sid, `/element/${elementId}/click`);
    const refKey = [...this.refs.entries()].find(([, e]) => e.label);
    const label = refKey ? ` (${refKey[1].elementType.replace("XCUIElementType", "")}: "${refKey[1].label}")` : "";
    return `Clicked${label}`;
  }
  async tapCoordinates(x, y) {
    const sid = this.ensureSession();
    await appiumPost(sid, "/actions", tapAction(x, y));
    return `Tapped at (${x}, ${y})`;
  }
  async fill(refOrSelector, text) {
    const sid = this.ensureSession();
    if (refOrSelector.startsWith("@")) {
      const finder = async (strategy, selector) => {
        const using = strategy === "accessibility id" ? "accessibility id" : "xpath";
        return findElement(sid, using, selector);
      };
      const result = await resolveRef(refOrSelector, this.refs, finder);
      if (!result) {
        throw new Error(`Cannot fill ${refOrSelector} \u2014 element not found`);
      }
      if (result.usedCoordinates) {
        const coords = result.element;
        await appiumPost(sid, "/actions", tapAction(coords.x, coords.y));
        await new Promise((r) => setTimeout(r, 500));
        const keyActions = [];
        for (const char of text) {
          keyActions.push({ type: "keyDown", value: char });
          keyActions.push({ type: "keyUp", value: char });
        }
        await appiumPost(sid, "/actions", {
          actions: [{ type: "key", id: "keyboard", actions: keyActions }]
        });
        return `Filled ${refOrSelector} with "${text}" (via coordinate tap + keyboard)`;
      }
      const elementId2 = result.element;
      await appiumPost(sid, `/element/${elementId2}/clear`);
      await appiumPost(sid, `/element/${elementId2}/value`, { text });
      return `Filled ${refOrSelector} with "${text}"`;
    }
    const elementId = await findElement(sid, "accessibility id", refOrSelector.replace(/^~/, ""));
    if (!elementId)
      throw new Error(`Element not found: ${refOrSelector}`);
    await appiumPost(sid, `/element/${elementId}/clear`);
    await appiumPost(sid, `/element/${elementId}/value`, { text });
    return `Filled ${refOrSelector} with "${text}"`;
  }
  async screenshot(outputPath) {
    const sid = this.ensureSession();
    const base64 = await appiumGet(sid, "/screenshot");
    const buffer = Buffer.from(base64, "base64");
    try {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, buffer);
    } catch (err) {
      throw new Error(`Screenshot save failed: ${err instanceof Error ? err.message : String(err)}. Disk may be full.`);
    }
    return `Screenshot saved to ${outputPath} (${buffer.length} bytes)`;
  }
  async snapshot(flags) {
    const sid = this.ensureSession();
    const xml = await appiumGet(sid, "/source");
    const result = parseXmlToRefs(xml);
    this.refs = result.refs;
    const isDiff = flags.includes("-D") || flags.includes("--diff");
    const isAnnotate = flags.includes("-a") || flags.includes("--annotate");
    let output = result.text;
    if (isDiff)
      output = snapshotDiff(this.lastSnapshot, result.text);
    this.lastSnapshot = result.text;
    if (isAnnotate) {
      const outputIdx = flags.indexOf("-o");
      const longOutputIdx = flags.indexOf("--output");
      const pathIdx = outputIdx >= 0 ? outputIdx + 1 : longOutputIdx >= 0 ? longOutputIdx + 1 : -1;
      if (pathIdx >= 0 && pathIdx < flags.length) {
        await this.screenshot(flags[pathIdx]);
        output += `

Annotated screenshot saved (note: mobile screenshots do not have overlay boxes)`;
      }
    }
    return output;
  }
  async text() {
    const sid = this.ensureSession();
    const xml = await appiumGet(sid, "/source");
    const labels = [];
    const labelRegex = /\blabel="([^"]*)"/g;
    const valueRegex = /\bvalue="([^"]*)"/g;
    let match;
    while ((match = labelRegex.exec(xml)) !== null) {
      if (match[1].trim())
        labels.push(match[1].trim());
    }
    while ((match = valueRegex.exec(xml)) !== null) {
      if (match[1].trim())
        labels.push(match[1].trim());
    }
    const seen = new Set;
    const unique = labels.filter((l) => {
      if (seen.has(l))
        return false;
      seen.add(l);
      return true;
    });
    return unique.join(`
`) || "(no visible text)";
  }
  async scroll(direction) {
    const sid = this.ensureSession();
    let startX = 200, startY = 400, endX = 200, endY = 400;
    switch (direction.toLowerCase()) {
      case "down":
        startY = 500;
        endY = 200;
        break;
      case "up":
        startY = 200;
        endY = 500;
        break;
      case "left":
        startX = 300;
        endX = 50;
        break;
      case "right":
        startX = 50;
        endX = 300;
        break;
      default:
        startY = 500;
        endY = 200;
    }
    await appiumPost(sid, "/actions", swipeAction(startX, startY, endX, endY));
    return `Scrolled ${direction || "down"}`;
  }
  async back() {
    const sid = this.ensureSession();
    await appiumPost(sid, "/back");
    return "Navigated back";
  }
  async viewport(size) {
    const sid = this.ensureSession();
    if (size.toLowerCase() === "landscape" || size.toLowerCase() === "portrait") {
      const orientation = size.toLowerCase() === "landscape" ? "LANDSCAPE" : "PORTRAIT";
      await appiumPost(sid, "/orientation", { orientation });
      return `Set orientation to ${orientation}`;
    }
    return `Viewport size change not supported mid-session. Use: "landscape" or "portrait"`;
  }
  async links() {
    if (this.refs.size === 0)
      return "(no tappable elements \u2014 run snapshot first)";
    const lines = [];
    for (const [key, entry] of this.refs) {
      const type = entry.elementType.replace("XCUIElementType", "");
      const label = entry.label ? ` "${entry.label}"` : "";
      lines.push(`@${key} ${type}${label}`);
    }
    return lines.join(`
`) || "(no tappable elements)";
  }
  async forms() {
    const inputTypes = new Set(["XCUIElementTypeTextField", "XCUIElementTypeSecureTextField", "XCUIElementTypeSearchField", "XCUIElementTypeTextView"]);
    const lines = [];
    for (const [key, entry] of this.refs) {
      if (inputTypes.has(entry.elementType)) {
        const type = entry.elementType.replace("XCUIElementType", "");
        const label = entry.label ? ` "${entry.label}"` : "";
        lines.push(`@${key} ${type}${label}`);
      }
    }
    return lines.join(`
`) || "(no input fields found)";
  }
  async dialogAccept() {
    const sid = this.ensureSession();
    try {
      await appiumPost(sid, "/alert/accept");
      return "Alert accepted";
    } catch {
      return "No alert to accept";
    }
  }
  async dialogDismiss() {
    const sid = this.ensureSession();
    try {
      await appiumPost(sid, "/alert/dismiss");
      return "Alert dismissed";
    } catch {
      return "No alert to dismiss";
    }
  }
}

// browse-mobile/src/server.ts
import * as fs2 from "fs";
import * as path2 from "path";
import * as crypto from "crypto";
var TOKEN = crypto.randomUUID();
var STATE_FILE = process.env.BROWSE_MOBILE_STATE_FILE || ".gstack/browse-mobile.json";
var IDLE_TIMEOUT_MS = parseInt(process.env.BROWSE_MOBILE_IDLE_TIMEOUT || "1800000", 10);
var mobileDriver = null;
var lastActivity = Date.now();
var idleTimer = null;
var commandQueue = Promise.resolve();
var READ_COMMANDS = new Set([
  "text",
  "links",
  "forms",
  "snapshot"
]);
var WRITE_COMMANDS = new Set([
  "goto",
  "click",
  "tap",
  "fill",
  "scroll",
  "back",
  "viewport",
  "dialog-accept",
  "dialog-dismiss"
]);
var META_COMMANDS = new Set([
  "screenshot",
  "status",
  "stop"
]);
var UNSUPPORTED_COMMANDS = new Set([
  "html",
  "css",
  "attrs",
  "js",
  "eval",
  "accessibility",
  "console",
  "network",
  "cookies",
  "storage",
  "perf",
  "dialog",
  "is",
  "forward",
  "reload",
  "select",
  "hover",
  "type",
  "press",
  "wait",
  "cookie",
  "cookie-import",
  "cookie-import-browser",
  "header",
  "useragent",
  "upload",
  "tabs",
  "tab",
  "newtab",
  "closetab",
  "pdf",
  "responsive",
  "chain",
  "diff",
  "url",
  "handoff",
  "resume"
]);
async function handleCommand(command, args) {
  if (!mobileDriver) {
    throw new Error("MobileDriver not initialized");
  }
  if (!mobileDriver.isConnected) {
    console.error("[browse-mobile] Not connected \u2014 attempting to connect to Appium...");
    await mobileDriver.connect();
    console.error("[browse-mobile] Connected to Appium (reconnect)");
  }
  if (UNSUPPORTED_COMMANDS.has(command)) {
    return JSON.stringify({
      error: "not_supported",
      message: `Command '${command}' is not supported in mobile mode.`,
      supported: false
    });
  }
  switch (command) {
    case "text":
      return mobileDriver.text();
    case "links":
      return mobileDriver.links();
    case "forms":
      return mobileDriver.forms();
    case "snapshot":
      return mobileDriver.snapshot(args);
    case "goto":
      if (args.length === 0)
        throw new Error("goto requires a target (e.g., app://com.example.app)");
      return mobileDriver.goto(args[0]);
    case "click":
      if (args.length === 0)
        throw new Error("click requires a ref (e.g., @e1) or label:Text");
      return mobileDriver.click(args[0]);
    case "tap": {
      if (args.length < 2)
        throw new Error("tap requires x y coordinates (e.g., tap 195 750)");
      const tapX = parseInt(args[0], 10);
      const tapY = parseInt(args[1], 10);
      if (isNaN(tapX) || isNaN(tapY))
        throw new Error(`Invalid coordinates: "${args[0]}" "${args[1]}" \u2014 must be numbers`);
      return mobileDriver.tapCoordinates(tapX, tapY);
    }
    case "fill":
      if (args.length < 2)
        throw new Error('fill requires a ref and text (e.g., @e1 "hello")');
      return mobileDriver.fill(args[0], args.slice(1).join(" "));
    case "scroll":
      return mobileDriver.scroll(args[0] || "down");
    case "back":
      return mobileDriver.back();
    case "viewport":
      if (args.length === 0)
        throw new Error("viewport requires a size (e.g., landscape, portrait)");
      return mobileDriver.viewport(args[0]);
    case "dialog-accept":
      return mobileDriver.dialogAccept();
    case "dialog-dismiss":
      return mobileDriver.dialogDismiss();
    case "screenshot": {
      const outputPath = args[0] || "/tmp/browse-mobile-screenshot.png";
      return mobileDriver.screenshot(outputPath);
    }
    case "status":
      return JSON.stringify({
        connected: mobileDriver.isConnected,
        refs: mobileDriver.getRefCount(),
        uptime: Math.floor((Date.now() - startTime) / 1000)
      });
    case "stop":
      await shutdown();
      return "Server stopped";
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
var startTime = Date.now();
async function findAvailablePort() {
  const explicit = process.env.BROWSE_MOBILE_PORT;
  if (explicit)
    return parseInt(explicit, 10);
  for (let attempt = 0;attempt < 5; attempt++) {
    const port = 1e4 + Math.floor(Math.random() * 50000);
    try {
      const test = Bun.serve({ port, fetch: () => new Response("ok") });
      test.stop(true);
      return port;
    } catch {
      continue;
    }
  }
  throw new Error("Could not find available port after 5 attempts");
}
async function shutdown() {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
  if (mobileDriver) {
    try {
      await mobileDriver.disconnect();
    } catch {}
    mobileDriver = null;
  }
  try {
    fs2.unlinkSync(STATE_FILE);
  } catch {}
  process.exit(0);
}
async function startServer() {
  const port = await findAvailablePort();
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        const healthy = mobileDriver ? await mobileDriver.isHealthy() : false;
        return Response.json({
          status: healthy ? "healthy" : "unhealthy",
          uptime: Math.floor((Date.now() - startTime) / 1000),
          refs: mobileDriver?.getRefCount() || 0
        });
      }
      const auth = req.headers.get("Authorization");
      if (auth !== `Bearer ${TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.pathname === "/command" && req.method === "POST") {
        lastActivity = Date.now();
        try {
          const body = await req.json();
          const { command, args = [] } = body;
          const result = await new Promise((resolve, reject) => {
            commandQueue = commandQueue.then(() => handleCommand(command, args)).then(resolve).catch(reject);
          });
          return new Response(result, {
            headers: { "Content-Type": "text/plain" }
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message, hint: getErrorHint(message) }, { status: 500 });
        }
      }
      return new Response("Not found", { status: 404 });
    }
  });
  const stateDir = path2.dirname(STATE_FILE);
  if (!fs2.existsSync(stateDir)) {
    fs2.mkdirSync(stateDir, { recursive: true });
  }
  const state = {
    pid: process.pid,
    port,
    token: TOKEN,
    startedAt: new Date().toISOString(),
    serverPath: import.meta.path
  };
  const tmpFile = STATE_FILE + ".tmp";
  fs2.writeFileSync(tmpFile, JSON.stringify(state), { mode: 384 });
  fs2.renameSync(tmpFile, STATE_FILE);
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      console.error("[browse-mobile] Idle timeout \u2014 shutting down");
      shutdown();
    }
  }, 60000);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.error(`[browse-mobile] Server running on port ${port} (pid ${process.pid})`);
}
function getErrorHint(message) {
  if (message.includes("not connected") || message.includes("session")) {
    return "Appium session may have died. Try: $BM goto app://your.bundle.id";
  }
  if (message.includes("no longer exists")) {
    return "Element was on a previous screen. Run: $BM snapshot -i to see current elements.";
  }
  if (message.includes("Disk may be full")) {
    return "Check available disk space with: df -h";
  }
  return;
}
async function init() {
  const cliArgs = process.argv.slice(2).filter((a) => a !== "--server");
  const bundleId = process.env.BROWSE_MOBILE_BUNDLE_ID || cliArgs[0] || "";
  if (!bundleId) {
    console.error("[browse-mobile] Warning: No bundle ID provided. Set BROWSE_MOBILE_BUNDLE_ID or pass as argument.");
  }
  const options = {
    bundleId,
    appPath: process.env.BROWSE_MOBILE_APP_PATH,
    deviceName: process.env.BROWSE_MOBILE_DEVICE_NAME,
    platformVersion: process.env.BROWSE_MOBILE_PLATFORM_VERSION
  };
  mobileDriver = new MobileDriver(options);
  await startServer();
  try {
    await mobileDriver.connect();
    console.error("[browse-mobile] Connected to Appium");
  } catch (err) {
    console.error(`[browse-mobile] Failed to connect to Appium: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[browse-mobile] Server is running \u2014 Appium connection will be retried on first command");
  }
}
init().catch((err) => {
  console.error(`[browse-mobile] Fatal error: ${err}`);
  process.exit(1);
});
