/* eslint-disable @typescript-eslint/no-explicit-any */
import jsonld from "jsonld";
import { suites } from "jsonld-signatures";
import { randomBytes } from "@stablelib/random";
import { v4 as uuidv4 } from "uuid";
import {
  blsCreateProofMulti,
  blsVerifyProofMulti
} from "@yamdan/bbs-signatures";
import { Bls12381G2KeyPair } from "@yamdan/bls12381-key-pair";

import {
  DidDocumentPublicKey,
  CreateVerifyDataOptions,
  CanonizeOptions,
  CanonicalizeOptions,
  RevealOptions,
  RevealResult,
  Statement,
  TermwiseCanonicalizeResult,
  DeriveProofMultiOptions,
  VerifyProofMultiOptions,
  VerifyProofMultiResult,
  TermwiseSkolemizeResult,
  DeriveProofOptions,
  VerifyProofOptions,
  VerifyProofResult
} from "./types";
import { BbsTermwiseSignature2021 } from "./BbsTermwiseSignature2021";
import { TermwiseStatement } from "./TermwiseStatement";
import { SECURITY_CONTEXT_URLS } from "./utilities";

class URIAnonymizer {
  private prefix = "urn:anon:";
  private regexp = /^<urn:anon:([^>]+)>/;

  private equivs: Map<string, [string, [number, number][]]> = new Map();

  constructor();
  constructor(equivs: Map<string, [string, [number, number][]]>);
  constructor(equivs?: Map<string, [string, [number, number][]]>) {
    if (equivs) {
      this.equivs = equivs;
    }
  }

  anonymizeJsonld(doc: any): any {
    const anonymizeDocument = (doc: any): void => {
      for (const [k, v] of Object.entries(doc)) {
        if (typeof v === "object") {
          anonymizeDocument(v);
        } else if (typeof v === "string") {
          const anid = this.equivs.get(`<${v}>`);
          if (anid !== undefined) {
            doc[k] = `${this.prefix}${anid[0]}`;
          }
        }
      }
    };

    const res = { ...doc }; // copy input
    anonymizeDocument(res);
    return res;
  }

  anonymizeStatement(s: Statement): Statement {
    for (const [uri, value] of this.equivs) {
      s = s.replace(uri.slice(1, -1), `${this.prefix}${value[0]}`);
    }
    return s;
  }

  extractAnonID(t: string): string | null {
    const found = t.match(this.regexp);
    if (found === null) return null;
    return found[1];
  }
}

export class BbsTermwiseSignatureProof2021 extends suites.LinkedDataProof {
  constructor({ useNativeCanonize, key, LDKeyClass, type }: any = {}) {
    super({
      type: "BbsTermwiseSignatureProof2021"
    });

    this.proof = {
      "@context": SECURITY_CONTEXT_URLS,
      type: "BbsTermwiseSignatureProof2021"
    };

    this.mappedDerivedProofType = "BbsTermwiseSignature2021";
    this.supportedDeriveProofType =
      BbsTermwiseSignatureProof2021.supportedDerivedProofType;
    this.LDKeyClass = LDKeyClass ?? Bls12381G2KeyPair;
    this.proofSignatureKey = "proofValue";
    this.key = key;
    this.useNativeCanonize = useNativeCanonize;
    this.Suite = BbsTermwiseSignature2021;
    this.Statement = TermwiseStatement;
  }

  // ported from
  // https://github.com/transmute-industries/verifiable-data/blob/main/packages/bbs-bls12381-signature-2020/src/BbsBlsSignatureProof2020.ts
  ensureSuiteContext({ document }: any): void {
    const contextUrl = "https://www.zkp-ld.org/bbs-termwise-2021.jsonld";
    if (
      document["@context"] === contextUrl ||
      (Array.isArray(document["@context"]) &&
        document["@context"].includes(contextUrl))
    ) {
      // document already includes the required context
      return;
    }
    throw new TypeError(
      `The document to be signed must contain this suite's @context, ` +
        `"${contextUrl}".`
    );
  }

  async canonize(input: any, options: CanonizeOptions): Promise<string> {
    const { documentLoader, expansionMap, skipExpansion } = options;
    return jsonld.canonize(input, {
      algorithm: "URDNA2015",
      format: "application/n-quads",
      documentLoader,
      expansionMap,
      skipExpansion,
      useNative: this.useNativeCanonize
    });
  }

  async canonizeProof(proof: any, options: CanonizeOptions): Promise<string> {
    const { documentLoader, expansionMap } = options;
    proof = { ...proof };

    delete proof.nonce;
    delete proof.proofValue;

    return this.canonize(proof, {
      documentLoader,
      expansionMap,
      skipExpansion: false
    });
  }

  /**
   * @param document {CreateVerifyDataOptions} options to create verify data
   *
   * @returns {Promise<Statement[]>}.
   */
  async createVerifyData(
    options: CreateVerifyDataOptions
  ): Promise<Statement[]> {
    const { proof, document, documentLoader, expansionMap } = options;

    const proofStatements = await this.createVerifyProofData(proof, {
      documentLoader,
      expansionMap
    });
    const documentStatements = await this.createVerifyDocumentData(document, {
      documentLoader,
      expansionMap
    });

    // concatenate c14n proof options and c14n document
    return proofStatements.concat(documentStatements);
  }

  /**
   * @param nQuads {string} canonized RDF N-Quads as a string
   *
   * @returns {Statement[]} an array of statements
   */
  getStatements(nQuads: string): Statement[] {
    return nQuads
      .split("\n")
      .filter((_) => _.length > 0)
      .map((s: string) => new this.Statement(s));
  }

  /**
   * @param proof to canonicalize
   * @param options to create verify data
   *
   * @returns {Promise<Statement[]>}.
   */
  async createVerifyProofData(
    proof: any,
    { documentLoader, expansionMap }: any
  ): Promise<Statement[]> {
    const c14nProofOptions = await this.canonizeProof(proof, {
      documentLoader,
      expansionMap
    });

    return this.getStatements(c14nProofOptions);
  }

  /**
   * @param document to canonicalize
   * @param options to create verify data
   *
   * @returns {Promise<Statement[]>}.
   */
  async createVerifyDocumentData(
    document: any,
    { documentLoader, expansionMap }: any
  ): Promise<Statement[]> {
    const c14nDocument = await this.canonize(document, {
      documentLoader,
      expansionMap
    });

    return this.getStatements(c14nDocument);
  }

  /**
   * @param document {object} to be signed.
   * @param proof {object}
   * @param documentLoader {function}
   * @param expansionMap {function}
   */
  async getVerificationMethod({
    proof,
    documentLoader
  }: any): Promise<DidDocumentPublicKey> {
    let { verificationMethod } = proof;

    if (typeof verificationMethod === "object") {
      verificationMethod = verificationMethod.id;
    }
    if (!verificationMethod) {
      throw new Error('No "verificationMethod" found in proof.');
    }

    // Note: `expansionMap` is intentionally not passed; we can safely drop
    // properties here and must allow for it
    const result = await jsonld.frame(
      verificationMethod,
      {
        // adding jws-2020 context to allow publicKeyJwk
        "@context": [
          "https://w3id.org/security/v2",
          "https://w3id.org/security/suites/jws-2020/v1"
        ],
        "@embed": "@always",
        id: verificationMethod
      },
      {
        documentLoader,
        compactToRelative: false,
        expandContext: SECURITY_CONTEXT_URLS
      }
    );
    if (!result) {
      throw new Error(`Verification method ${verificationMethod} not found.`);
    }

    // ensure verification method has not been revoked
    if (result.revoked !== undefined) {
      throw new Error("The verification method has been revoked.");
    }

    return result;
  }

  /**
   * Get canonical N-Quads from JSON-LD
   *
   * @param document to canonicalize
   * @param proof to canonicalize
   * @param options to create verify data
   *
   * @returns {Promise<TermwiseCanonicalizeResult>} canonicalized statements
   */
  async canonicalize(
    document: string,
    proof: string,
    options: CanonicalizeOptions
  ): Promise<TermwiseCanonicalizeResult> {
    const { suite, documentLoader, expansionMap, skipProofCompaction } =
      options;

    // Get the input document statements
    const documentStatements: TermwiseStatement[] =
      await suite.createVerifyDocumentData(document, {
        documentLoader,
        expansionMap,
        compactProof: !skipProofCompaction
      });

    // Get the proof statements
    const proofStatements: TermwiseStatement[] =
      await suite.createVerifyProofData(proof, {
        documentLoader,
        expansionMap,
        compactProof: !skipProofCompaction
      });

    return { documentStatements, proofStatements };
  }

  /**
   * Name all the blank nodes
   *
   * @param documentStatements to skolemize
   *
   * @returns {Promise<TermwiseSkolemizeResult>} skolemized JSON-LD document and statements
   */
  async skolemize(
    documentStatements: TermwiseStatement[],
    auxilliaryIndex?: number
  ): Promise<TermwiseSkolemizeResult> {
    // Transform any blank node identifiers for the input
    // document statements into actual node identifiers
    // e.g., _:c14n0 => <urn:bnid:_:c14n0>
    const skolemizedDocumentStatements = documentStatements.map((element) =>
      element.skolemize(auxilliaryIndex)
    );

    // Transform the resulting RDF statements back into JSON-LD
    const skolemizedDocument: string = await jsonld.fromRDF(
      skolemizedDocumentStatements.join("\n")
    );

    return { skolemizedDocument, skolemizedDocumentStatements };
  }

  /**
   * Unname all the blank nodes
   *
   * @param documentStatements to deskolemize
   *
   * @returns {Promise<DeskolemizeResult>} deskolemized JSON-LD document and statements
   */
  async deskolemize(
    skolemizedDocumentStatements: TermwiseStatement[]
  ): Promise<TermwiseStatement[]> {
    // Transform the blank node identifier placeholders for the document statements
    // back into actual blank node identifiers
    // e.g., <urn:bnid:_:c14n0> => _:c14n0
    const documentStatements = skolemizedDocumentStatements.map((element) =>
      element.deskolemize()
    );
    return documentStatements;
  }

  /**
   * Extract revealed parts using JSON-LD Framing
   *
   * @param skolemizedDocument JSON-LD document
   * @param revealDocument JSON-LD frame
   * @param options for framing and createVerifyData
   *
   * @returns {Promise<RevealResult>} revealed JSON-LD document and statements
   */
  async reveal(
    skolemizedDocument: string,
    revealDocument: string,
    options: RevealOptions
  ): Promise<RevealResult> {
    const { suite, documentLoader, expansionMap } = options;

    // Frame the result to create the reveal document result
    const revealedDocument = await jsonld.frame(
      skolemizedDocument,
      revealDocument,
      { documentLoader }
    );

    // Canonicalize the resulting reveal document
    const revealedDocumentStatements = await suite.createVerifyDocumentData(
      revealedDocument,
      {
        documentLoader,
        expansionMap
      }
    );

    return { revealedDocument, revealedDocumentStatements };
  }

  /**
   * Calculate reveal indicies
   *
   * @param skolemizedDocumentStatements full document statements
   * @param revealedDocumentStatements revealed document statements
   * @param proofStatements proof statements
   *
   * @returns {Promise<RevealResult>} revealed JSON-LD document and statements
   */
  getIndicies(
    skolemizedDocumentStatements: Statement[],
    revealedDocumentStatements: Statement[],
    proofStatements: Statement[]
  ): number[] {
    const NUM_OF_TERMS_IN_STATEMENT = 4;

    //Get the indicies of the revealed statements from the transformed input document offset
    //by the number of proof statements
    const numberOfProofStatements = proofStatements.length;

    //Always reveal all the statements associated to the original proof
    //these are always the first statements in the normalized form
    const proofRevealIndicies = Array.from(
      Array(numberOfProofStatements).keys()
    );

    //Reveal the statements indicated from the reveal document
    const documentRevealIndicies = revealedDocumentStatements.map((key) => {
      const idx = skolemizedDocumentStatements.findIndex(
        (e) => e.toString() === key.toString()
      );
      if (idx === -1) {
        throw new Error(
          "Some statements in the reveal document not found in original proof"
        );
      }
      return idx + numberOfProofStatements;
    });

    // Check there is not a mismatch
    if (documentRevealIndicies.length !== revealedDocumentStatements.length) {
      throw new Error(
        "Some statements in the reveal document not found in original proof"
      );
    }

    // Combine all indicies to get the resulting list of revealed indicies
    const BaseRevealIndicies = proofRevealIndicies.concat(
      documentRevealIndicies
    );

    // Expand indicies to fit termwise encoding
    // e.g., [0, 2, 5] -> [0,1,2,3, 8,9,10,11, 20,21,22,23]
    const revealIndicies = BaseRevealIndicies.flatMap((index) =>
      [...Array(NUM_OF_TERMS_IN_STATEMENT).keys()].map(
        (i) => index * NUM_OF_TERMS_IN_STATEMENT + i
      )
    );
    return revealIndicies;
  }

  statementToUint8(statementArray: Statement[][]): Uint8Array {
    return new Uint8Array(
      Buffer.from(
        statementArray
          .map((statements) =>
            statements.map((statement) => statement.toString()).join("")
          )
          .join("")
      )
    );
  }

  /**
   * Derive a proof from a proof and reveal document
   *
   * @param options {object} options for deriving a proof.
   *
   * @returns {Promise<object>} Resolves with the derived proof object.
   */
  // eslint-disable-next-line @typescript-eslint/ban-types
  async deriveProof(options: DeriveProofOptions): Promise<object> {
    const {
      document,
      proof,
      revealDocument,
      documentLoader,
      expansionMap,
      skipProofCompaction,
      nonce,
      hiddenUris
    } = options;

    const derivedProofs = await this.deriveProofMulti({
      inputDocuments: [
        {
          document,
          proof,
          revealDocument
        }
      ],
      documentLoader,
      expansionMap,
      skipProofCompaction,
      nonce,
      hiddenUris
    });

    return derivedProofs[0];
  }

  /**
   * Derive proofs from multiple proofs and reveal documents
   *
   * @param options {object} options for deriving proofs.
   *
   * @returns {Promise<object[]>} Resolves with the array of derived proofs object.
   */
  // eslint-disable-next-line @typescript-eslint/ban-types
  async deriveProofMulti(options: DeriveProofMultiOptions): Promise<object[]> {
    const {
      inputDocuments,
      documentLoader,
      expansionMap,
      skipProofCompaction,
      hiddenUris = []
    } = options;
    let { nonce } = options;

    // Create a nonce if one is not supplied
    if (!nonce) {
      nonce = await randomBytes(50);
    }

    const termsArray: Uint8Array[][] = [];
    const revealIndiciesArray: number[][] = [];
    const issuerPublicKeyArray: Buffer[] = [];
    const signatureArray: Buffer[] = [];
    const revealedDocuments: any = [];
    const derivedProofs: any = [];
    const anonymizedRevealedStatementsArray: Statement[][] = [];

    const equivs: Map<string, [string, [number, number][]]> = new Map(
      hiddenUris.map((uri) => [`<${uri}>`, [uuidv4(), []]])
    );

    const anonymizer = new URIAnonymizer(equivs);

    let index = 0;
    for (const { document, proof, revealDocument } of inputDocuments) {
      // Validate that the input proof document has a proof compatible with this suite
      if (
        !BbsTermwiseSignatureProof2021.supportedDerivedProofType.includes(
          proof.type
        )
      ) {
        throw new TypeError(
          `proof document proof incompatible, expected proof types of ${JSON.stringify(
            BbsTermwiseSignatureProof2021.supportedDerivedProofType
          )} received ${proof.type}`
        );
      }

      // Extract the BBS signature from the input proof
      const signature = Buffer.from(proof[this.proofSignatureKey], "base64");
      signatureArray.push(signature);

      // Initialize the signature suite
      const suite = new this.Suite();

      // Initialize the derived proof
      let derivedProof;
      if (this.proof) {
        // use proof JSON-LD document passed to API
        derivedProof = await jsonld.compact(this.proof, SECURITY_CONTEXT_URLS, {
          documentLoader,
          expansionMap,
          compactToRelative: false
        });
      } else {
        // create proof JSON-LD document
        derivedProof = { "@context": SECURITY_CONTEXT_URLS };
      }

      // ensure proof type is set
      derivedProof.type = this.type;

      // canonicalize: get N-Quads from JSON-LD
      const { documentStatements, proofStatements } = await this.canonicalize(
        document,
        proof,
        {
          suite,
          documentLoader,
          expansionMap,
          skipProofCompaction
        }
      );

      // concat proof and document to generate
      const terms = proofStatements
        .concat(documentStatements)
        .flatMap((item: TermwiseStatement) => item.toTerms());

      termsArray.push(
        terms.map((term: string) => new Uint8Array(Buffer.from(term)))
      );

      // skolemize: name all the blank nodes
      // e.g., _:c14n0 -> urn:bnid:0:_:c14n0
      const { skolemizedDocument, skolemizedDocumentStatements } =
        await this.skolemize(documentStatements, index);

      // add blank node identifiers to equivs array
      const skolemizedTerms = proofStatements
        .concat(skolemizedDocumentStatements)
        .flatMap((item: TermwiseStatement) => item.toTerms());
      new Set(
        skolemizedTerms.filter((term) =>
          term.match(/^<urn:bnid:[0-9]+:_:c14n[0-9]+>$/)
        )
      ).forEach((skolemizedBnid) => {
        equivs.set(skolemizedBnid, [uuidv4(), []]);
      });

      // reveal: extract revealed parts using JSON-LD Framing
      const { revealedDocument } = await this.reveal(
        skolemizedDocument,
        revealDocument,
        {
          suite,
          documentLoader,
          expansionMap
        }
      );

      // prepare anonymized JSON-LD document to be revealed to verifier
      // by replacing hiddenURIs by anonymized IDs
      const anonymizedRevealedDocument =
        anonymizer.anonymizeJsonld(revealedDocument);
      revealedDocuments.push(anonymizedRevealedDocument);

      // getIndicies: calculate reveal indicies
      //   compare anonymized statements and anonymized revealed statements
      //   to compute reveal indicies
      const anonymizedStatements = skolemizedDocumentStatements.map(
        (s: TermwiseStatement) => anonymizer.anonymizeStatement(s)
      );
      const anonymizedRevealedStatements = await this.createVerifyDocumentData(
        anonymizedRevealedDocument,
        {
          suite,
          documentLoader,
          expansionMap,
          skipProofCompaction
        }
      );
      const revealIndicies = this.getIndicies(
        anonymizedStatements,
        anonymizedRevealedStatements,
        proofStatements
      );
      anonymizedRevealedStatementsArray.push(anonymizedRevealedStatements);
      revealIndiciesArray.push(revealIndicies);

      // add term indicies of hidden URIs to equivs array
      skolemizedTerms.forEach((term, termIndex) => {
        if (equivs.has(term) && revealIndicies.includes(termIndex)) {
          const e = equivs.get(term) as [string, [number, number][]];
          e[1].push([index, termIndex]);
        }
      });

      // Fetch the verification method
      const verificationMethod = await this.getVerificationMethod({
        proof,
        document,
        documentLoader,
        expansionMap
      });
      // Construct a key pair class from the returned verification method
      const issuerPublicKey = verificationMethod.publicKeyJwk
        ? await this.LDKeyClass.fromJwk(verificationMethod)
        : await this.LDKeyClass.from(verificationMethod);
      issuerPublicKeyArray.push(issuerPublicKey.publicKeyBuffer);

      // Set the relevant proof elements on the derived proof from the input proof
      derivedProof.verificationMethod = proof.verificationMethod;
      derivedProof.proofPurpose = proof.proofPurpose;
      derivedProof.created = proof.created;
      // Set the nonce on the derived proof
      derivedProof.nonce = Buffer.from(nonce).toString("base64");
      derivedProofs.push(derivedProof);

      index++;
    }

    const equivsArray: [number, number][][] = [...equivs.values()].map(
      (v) => v[1]
    );

    // merge revealed statements into nonce (should be separated as claims?)
    const revealedStatementsByte = this.statementToUint8(
      anonymizedRevealedStatementsArray
    );
    const mergedNonce = new Uint8Array(
      nonce.length + revealedStatementsByte.length
    );
    mergedNonce.set(nonce);
    mergedNonce.set(revealedStatementsByte, nonce.length);

    // Compute the proof
    const outputProofs = await blsCreateProofMulti({
      signature: signatureArray.map((signature) => new Uint8Array(signature)),
      publicKey: issuerPublicKeyArray.map(
        (issuerPublicKey: Buffer) => new Uint8Array(issuerPublicKey)
      ),
      messages: termsArray,
      nonce: mergedNonce,
      revealed: revealIndiciesArray,
      equivs: equivsArray
    });

    // Set the proof value on the derived proof
    const results = [];
    for (let i = 0; i < revealedDocuments.length; i++) {
      derivedProofs[i].proofValue = Buffer.from(outputProofs[i].value).toString(
        "base64"
      );
      results.push({
        document: revealedDocuments[i],
        proof: derivedProofs[i]
      });
    }

    return results;
  }

  /**
   * @param options {object} options for verifying the proof.
   *
   * @returns {Promise<{object}>} Resolves with the verification result.
   */
  async verifyProof(options: VerifyProofOptions): Promise<VerifyProofResult> {
    const { document, documentLoader, expansionMap, purpose, proof } = options;

    const result = await this.verifyProofMulti({
      inputDocuments: [
        {
          document,
          proof
        }
      ],
      documentLoader,
      expansionMap,
      purpose
    });

    if (result.results) {
      return result.results[0];
    } else {
      return { verified: result.verified, error: result.error };
    }
  }

  /**
   * @param options {object} options for verifying the proof.
   *
   * @returns {Promise<{object}>} Resolves with the verification result.
   */
  async verifyProofMulti(
    options: VerifyProofMultiOptions
  ): Promise<VerifyProofMultiResult> {
    const { inputDocuments, documentLoader, expansionMap, purpose } = options;

    const messagesArray: Uint8Array[][] = [];
    const proofArray: { value: Uint8Array }[] = [];
    const issuerPublicKeyArray: Uint8Array[] = [];
    const equivs: Map<string, [number, number][]> = new Map();
    const documentStatementsArray: Statement[][] = [];

    const anonymizer = new URIAnonymizer();

    let previous_nonce = "";

    try {
      let index = 0;
      for (const { document, proof } of inputDocuments) {
        // TODO: handle the case of empty nonce
        if (proof.nonce !== previous_nonce && previous_nonce !== "") {
          throw new Error(
            "all the nonces in credentials must have the same values"
          );
        }
        previous_nonce = proof.nonce;

        proofArray.push({
          value: new Uint8Array(Buffer.from(proof.proofValue, "base64"))
        });

        proof.type = this.mappedDerivedProofType;

        // canonicalize: get N-Quads from JSON-LD
        const { documentStatements, proofStatements } = await this.canonicalize(
          document,
          proof,
          {
            suite: this,
            documentLoader,
            expansionMap
          }
        );
        documentStatementsArray.push(documentStatements);

        // concat proof and document to be verified
        const terms = proofStatements
          .concat(documentStatements)
          .flatMap((item: TermwiseStatement) => item.toTerms());

        messagesArray.push(
          terms.map((term: string) => new Uint8Array(Buffer.from(term)))
        );

        // extract blinding indicies from anonIDs
        terms.forEach((term, termIndex) => {
          const found = anonymizer.extractAnonID(term);
          if (found !== null) {
            if (equivs.has(found)) {
              equivs.get(found)?.push([index, termIndex]);
            } else {
              equivs.set(found, [[index, termIndex]]);
            }
          }
        });

        // Fetch the verification method
        const verificationMethod = await this.getVerificationMethod({
          proof,
          document,
          documentLoader,
          expansionMap
        });

        // Ensure proof was performed for a valid purpose
        const { valid, error } = await purpose.validate(proof, {
          document,
          suite: this,
          verificationMethod,
          documentLoader,
          expansionMap
        });
        if (!valid) {
          throw error;
        }

        // Construct a key pair class from the returned verification method
        const key = verificationMethod.publicKeyJwk
          ? await this.LDKeyClass.fromJwk(verificationMethod)
          : await this.LDKeyClass.from(verificationMethod);

        issuerPublicKeyArray.push(new Uint8Array(key.publicKeyBuffer));

        index++;
      }

      const equivsArray: [number, number][][] = [...equivs.entries()]
        .sort()
        .map((e) => e[1]);

      // merge document statements into nonce (should be separated as claims?)
      const documentStatementsByte = this.statementToUint8(
        documentStatementsArray
      );
      const nonce = new Uint8Array(
        Buffer.from(previous_nonce as string, "base64")
      );
      const mergedNonce = new Uint8Array(
        nonce.length + documentStatementsByte.length
      );
      mergedNonce.set(nonce);
      mergedNonce.set(documentStatementsByte, nonce.length);

      // Verify the proof
      const verified = await blsVerifyProofMulti({
        proof: proofArray,
        publicKey: issuerPublicKeyArray,
        messages: messagesArray,
        nonce: mergedNonce,
        equivs: equivsArray
      });

      return verified;
    } catch (error: any) {
      return { verified: false, error };
    }
  }

  static proofType = [
    "BbsTermwiseSignatureProof2021",
    "https://www.zkp-ld.org/security#BbsTermwiseSignatureProof2021"
  ];

  static supportedDerivedProofType = [
    "BbsTermwiseSignature2021",
    "https://www.zkp-ld.org/security#BbsTermwiseSignature2021"
  ];
}