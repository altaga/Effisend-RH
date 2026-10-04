// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Effisend NFT collection (EVM). Every token shares one metadata URI.
///
/// Token ids start at 0 on purpose: the Effisend app reads a collection by
/// calling balanceOf() and then tokenURI(0) (see evmChain.js getNFTs), so
/// token 0 must exist and the URI must end in ".json" for the app to use it
/// as-is for every token.
///
/// Supports both distribution flows:
/// - mintBatch() to the operator (treasury), then distribute() hands out the
///   next undistributed token, in id order, with no off-chain bookkeeping.
/// - mint(to) straight to a recipient.
contract EffisendNFT is ERC721, Ownable {
    uint256 public totalMinted;
    uint256 public nextToDistribute;
    string private _sharedURI;

    constructor(string memory name_, string memory symbol_, string memory uri_, address owner_)
        ERC721(name_, symbol_)
        Ownable(owner_)
    {
        _sharedURI = uri_;
    }

    function mint(address to) external onlyOwner returns (uint256 tokenId) {
        tokenId = totalMinted++;
        _mint(to, tokenId);
    }

    function mintBatch(uint256 quantity) external onlyOwner {
        uint256 id = totalMinted;
        for (uint256 i = 0; i < quantity; i++) {
            _mint(msg.sender, id++);
        }
        totalMinted = id;
    }

    /// Transfers the next token still held by the owner to `to`. Tokens the
    /// owner no longer holds (e.g. minted straight to a user) are skipped.
    function distribute(address to) external onlyOwner returns (uint256 tokenId) {
        uint256 id = nextToDistribute;
        while (id < totalMinted && _ownerOf(id) != msg.sender) {
            id++;
        }
        require(id < totalMinted, "No tokens left to distribute");
        nextToDistribute = id + 1;
        _transfer(msg.sender, to, id);
        return id;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _sharedURI;
    }

    function setURI(string calldata uri_) external onlyOwner {
        _sharedURI = uri_;
    }
}
