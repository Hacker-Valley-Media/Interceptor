import Foundation
import NaturalLanguage

final class NLPDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "entities":
            extractEntities(action, completion: completion)
        case "language":
            detectLanguage(action, completion: completion)
        case "sentiment":
            analyzeSentiment(action, completion: completion)
        case "tokens":
            tokenize(action, completion: completion)
        case "similar":
            computeSimilarity(action, completion: completion)
        case "embed":
            getEmbedding(action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func extractEntities(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let text = action["text"] as? String else {
            completion(WireFormat.error("entities requires a text string"))
            return
        }
        let tagger = NLTagger(tagSchemes: [.nameType])
        tagger.string = text
        var entities: [[String: String]] = []
        tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word, scheme: .nameType, options: [.omitWhitespace, .omitPunctuation, .joinNames]) { tag, range in
            if let tag = tag, tag != .otherWord {
                entities.append(["text": String(text[range]), "type": tag.rawValue])
            }
            return true
        }
        completion(WireFormat.success(entities))
    }

    private func detectLanguage(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let text = action["text"] as? String else {
            completion(WireFormat.error("language requires a text string"))
            return
        }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        if let lang = recognizer.dominantLanguage {
            let hypotheses = recognizer.languageHypotheses(withMaximum: 5)
            var results: [[String: Any]] = []
            for (language, confidence) in hypotheses.sorted(by: { $0.value > $1.value }) {
                results.append(["language": language.rawValue, "confidence": confidence])
            }
            completion(WireFormat.success(["dominant": lang.rawValue, "hypotheses": results]))
        } else {
            completion(WireFormat.error("could not detect language"))
        }
    }

    private func analyzeSentiment(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let text = action["text"] as? String else {
            completion(WireFormat.error("sentiment requires a text string"))
            return
        }
        let tagger = NLTagger(tagSchemes: [.sentimentScore])
        tagger.string = text
        let (tag, _) = tagger.tag(at: text.startIndex, unit: .paragraph, scheme: .sentimentScore)
        if let tag = tag, let score = Double(tag.rawValue) {
            let label: String
            if score > 0.1 { label = "positive" }
            else if score < -0.1 { label = "negative" }
            else { label = "neutral" }
            completion(WireFormat.success(["score": score, "label": label]))
        } else {
            completion(WireFormat.success(["score": 0.0, "label": "neutral"]))
        }
    }

    private func tokenize(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let text = action["text"] as? String else {
            completion(WireFormat.error("tokens requires a text string"))
            return
        }
        let tokenizer = NLTokenizer(unit: .word)
        tokenizer.string = text
        var tokens: [String] = []
        tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
            tokens.append(String(text[range]))
            return true
        }
        completion(WireFormat.success(tokens))
    }

    private func computeSimilarity(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let word1 = action["word1"] as? String,
              let word2 = action["word2"] as? String else {
            completion(WireFormat.error("similar requires word1 and word2"))
            return
        }
        if let embedding = NLEmbedding.wordEmbedding(for: .english) {
            let distance = embedding.distance(between: word1, and: word2)
            completion(WireFormat.success(["distance": distance, "word1": word1, "word2": word2]))
        } else {
            completion(WireFormat.error("word embedding not available for English"))
        }
    }

    private func getEmbedding(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let text = action["text"] as? String else {
            completion(WireFormat.error("embed requires a text string"))
            return
        }
        if let embedding = NLEmbedding.wordEmbedding(for: .english),
           let vector = embedding.vector(for: text) {
            completion(WireFormat.success(["vector": vector, "dimensions": vector.count]))
        } else {
            completion(WireFormat.error("could not generate embedding for: \(text)"))
        }
    }
}
